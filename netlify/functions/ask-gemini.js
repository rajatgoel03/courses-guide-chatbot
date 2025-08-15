const { google } = require('googleapis');
const stream = require('stream');
const util = require('util');

// Libraries for parsing file content
const pdf = require('pdf-parse');
const mammoth = require('mammoth');
const JSZip = require('jszip');

// --- Caching Mechanism ---
// We store the processed text in memory to speed up subsequent requests.
let cachedKnowledgeBase = null;
let cacheTimestamp = 0;
const CACHE_DURATION = 5 * 60 * 1000; // Cache for 5 minutes (in milliseconds)

// Main handler for the Netlify serverless function
exports.handler = async function(event) {
    if (event.httpMethod !== 'POST') {
        return { statusCode: 405, body: JSON.stringify({ error: 'Method Not Allowed' }) };
    }

    try {
        // --- Retrieve and Validate Environment Variables ---
        const { GEMINI_API_KEY, DRIVE_API_CREDENTIALS, DRIVE_FOLDER_ID } = process.env;
        if (!GEMINI_API_KEY) throw new Error("Server configuration error: GEMINI_API_KEY is missing.");
        if (!DRIVE_API_CREDENTIALS) throw new Error("Server configuration error: DRIVE_API_CREDENTIALS is missing.");
        if (!DRIVE_FOLDER_ID) throw new Error("Server configuration error: DRIVE_FOLDER_ID is missing.");

        let knowledgeBase;
        const now = Date.now();

        // Check if we have a valid cache
        if (cachedKnowledgeBase && (now - cacheTimestamp < CACHE_DURATION)) {
            console.log("Using cached knowledge base.");
            knowledgeBase = cachedKnowledgeBase;
        } else {
            console.log("Cache is invalid or expired. Fetching from Google Drive...");
            let credentials;
            try {
                credentials = JSON.parse(DRIVE_API_CREDENTIALS);
            } catch (e) {
                throw new Error("Server configuration error: DRIVE_API_CREDENTIALS is not valid JSON.");
            }
            
            const auth = new google.auth.GoogleAuth({
                credentials,
                scopes: ['https://www.googleapis.com/auth/drive.readonly'],
            });
            const drive = google.drive({ version: 'v3', auth });

            knowledgeBase = await getKnowledgeFromDrive(drive, DRIVE_FOLDER_ID);
            if (!knowledgeBase) {
                throw new Error('Could not retrieve any content from the Google Drive folder.');
            }
            
            // Update the cache
            cachedKnowledgeBase = knowledgeBase;
            cacheTimestamp = now;
            console.log("Knowledge base cached successfully.");
        }

        // --- Prepare and Call Gemini API ---
        const { userQuestion } = JSON.parse(event.body);
        if (!userQuestion) throw new Error('No user question was provided.');

        const prompt = `You are a helpful university course assistant named 'Courses Guide'. Your job is to answer student questions based ONLY on the provided course information from the documents. If the answer is not found, you must say "I'm sorry, I don't have information on that." Do not make up answers.\n\nHere is the course information:\n---\n${knowledgeBase}\n---\n\nNow, please answer the following question: "${userQuestion}"`;
        const payload = { contents: [{ parts: [{ text: prompt }] }] };
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

        // --- Return Successful Response to Frontend ---
        return {
            statusCode: 200,
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(result),
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

// --- Helper function to get all file content from a Drive folder ---
async function getKnowledgeFromDrive(drive, folderId) {
    const res = await drive.files.list({
        q: `'${folderId}' in parents and trashed = false`,
        fields: 'files(id, name, mimeType)',
    });
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
            } else {
                textContent += `[Unsupported file type: ${file.name}]`;
            }
            return textContent;
        } catch (err) {
            console.error(`- FAILED to parse file ${file.name}:`, err);
            return `[Error reading file: ${file.name}]`;
        }
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
