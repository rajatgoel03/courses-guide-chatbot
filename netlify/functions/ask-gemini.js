const { google } = require('googleapis');
const stream = require('stream');
const util = require('util');
const pdf = require('pdf-parse');
const mammoth = require('mammoth');
const JSZip = require('jszip');

// --- Caching Mechanism ---
let cachedKnowledgeBase = null;
let cacheTimestamp = 0;
const CACHE_DURATION = 15 * 60 * 1000; // 15 minutes

exports.handler = async function(event) {
    if (event.httpMethod !== 'POST') {
        return { statusCode: 405, body: JSON.stringify({ error: 'Method Not Allowed' }) };
    }

    try {
        const { GEMINI_API_KEY, DRIVE_API_CREDENTIALS, DRIVE_FOLDER_ID } = process.env;
        if (!GEMINI_API_KEY || !DRIVE_API_CREDENTIALS || !DRIVE_FOLDER_ID) {
            throw new Error("Server configuration error: Missing environment variables.");
        }

        let knowledgeBase;
        const now = Date.now();

        if (cachedKnowledgeBase && (now - cacheTimestamp < CACHE_DURATION)) {
            knowledgeBase = cachedKnowledgeBase;
        } else {
            let credentials = JSON.parse(DRIVE_API_CREDENTIALS);
            const auth = new google.auth.GoogleAuth({ credentials, scopes: ['https://www.googleapis.com/auth/drive.readonly'] });
            const drive = google.drive({ version: 'v3', auth });
            knowledgeBase = await getKnowledgeFromDrive(drive, DRIVE_FOLDER_ID);
            if (!knowledgeBase) throw new Error('Could not retrieve content from Google Drive.');
            cachedKnowledgeBase = knowledgeBase;
            cacheTimestamp = now;
        }

        const { chatHistory } = JSON.parse(event.body);
        if (!chatHistory || !Array.isArray(chatHistory)) {
            throw new Error("Invalid chat history provided.");
        }

        // --- Construct the conversational payload for Gemini API ---
        const systemInstruction = {
            role: 'user',
            parts: [{ text: `You are a helpful university course assistant named 'Courses Guide'. Your job is to answer student questions based ONLY on the provided course information. If the answer is not found, you must say "I'm sorry, I don't have information on that." Do not make up answers. Here is the course information:\n\n---\n${knowledgeBase}\n---` }]
        };

        const payload = {
            contents: [systemInstruction, ...chatHistory]
        };

        const API_URL = `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash-preview-05-20:generateContent?key=${GEMINI_API_KEY}`;
        
        const geminiResponse = await fetch(API_URL, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(payload)
        });

        if (!geminiResponse.ok) {
            const errorData = await geminiResponse.json();
            throw new Error(errorData.error?.message || 'Failed to fetch from Gemini API.');
        }

        const result = await geminiResponse.json();
        const botResponse = result.candidates?.[0]?.content;
        
        if (!botResponse) {
             throw new Error("Received an empty or invalid response from the Gemini API.");
        }

        return {
            statusCode: 200,
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ candidates: [{ content: botResponse }] }),
        };

    } catch (error) {
        console.error('SERVER-SIDE CRASH:', error);
        return {
            statusCode: 500,
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ error: `Function Error: ${error.message}` || 'An internal server error occurred.' }),
        };
    }
};

// --- Helper functions (getKnowledgeFromDrive, streamToBuffer) remain the same ---
async function getKnowledgeFromDrive(drive, folderId) {
    const res = await drive.files.list({ q: `'${folderId}' in parents and trashed = false`, fields: 'files(id, name, mimeType)' });
    const files = res.data.files;
    if (!files || files.length === 0) return '';
    const filePromises = files.map(async (file) => {
        try {
            const fileStream = await drive.files.get({ fileId: file.id, alt: 'media' }, { responseType: 'stream' });
            const buffer = await streamToBuffer(fileStream.data);
            let textContent = `[Content from file: ${file.name}]\n`;
            if (file.mimeType === 'application/pdf') {
                const data = await pdf(buffer);
                textContent += data.text;
            } else if (file.mimeType === 'application/vnd.openxmlformats-officedocument.wordprocessingml.document') {
                const { value } = await mammoth.extractRawText({ buffer });
                textContent += value;
            } else if (file.mimeType === 'application/vnd.openxmlformats-officedocument.presentationml.presentation') {
                const zip = await JSZip.loadAsync(buffer);
                const slidePromises = [];
                zip.folder("ppt/slides").forEach((relativePath, file) => {
                    if (relativePath.endsWith('.xml')) slidePromises.push(file.async("string"));
                });
                const slideXmls = await Promise.all(slidePromises);
                textContent += slideXmls.map(xml => (xml.match(/<a:t>.*?<\/a:t>/g) || []).map(tag => tag.replace(/<.*?>/g, "")).join(' ')).join('\n');
            } else { textContent += `[Unsupported file type: ${file.name}]`; }
            return textContent;
        } catch (err) { return `[Error reading file: ${file.name}]`; }
    });
    const allTexts = await Promise.all(filePromises);
    return allTexts.join('\n\n---\n\n');
}
function streamToBuffer(stream) {
    return new Promise((resolve, reject) => {
        const chunks = [];
        stream.on('data', (chunk) => chunks.push(chunk));
        stream.on('error', reject);
        stream.on('end', () => resolve(Buffer.concat(chunks)));
    });
}
