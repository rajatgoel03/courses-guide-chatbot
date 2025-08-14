const { google } = require('googleapis');
const stream = require('stream');
const util = require('util');

// Libraries for parsing file content, installed via package.json
const pdf = require('pdf-parse');
const mammoth = require('mammoth');
const JSZip = require('jszip');


// Main handler for the Netlify serverless function
exports.handler = async function(event) {
    if (event.httpMethod !== 'POST') {
        return { statusCode: 405, body: 'Method Not Allowed' };
    }

    // --- Retrieve Environment Variables ---
    const { GEMINI_API_KEY, DRIVE_API_CREDENTIALS, DRIVE_FOLDER_ID } = process.env;
    if (!GEMINI_API_KEY || !DRIVE_API_CREDENTIALS || !DRIVE_FOLDER_ID) {
        return { statusCode: 500, body: JSON.stringify({ error: 'Server is not configured correctly. Missing API keys or Folder ID.' }) };
    }

    try {
        const { userQuestion } = JSON.parse(event.body);
        if (!userQuestion) {
            return { statusCode: 400, body: JSON.stringify({ error: 'No user question provided.' }) };
        }

        // --- Authenticate and Connect to Google Drive ---
        const credentials = JSON.parse(DRIVE_API_CREDENTIALS);
        const auth = new google.auth.GoogleAuth({
            credentials,
            scopes: ['https://www.googleapis.com/auth/drive.readonly'],
        });
        const drive = google.drive({ version: 'v3', auth });

        // --- Fetch and Parse Files from Drive ---
        const knowledgeBase = await getKnowledgeFromDrive(drive, DRIVE_FOLDER_ID);
        if (!knowledgeBase) {
            return { statusCode: 500, body: JSON.stringify({ error: 'Could not retrieve any content from the Google Drive folder. Ensure files are present and the folder is shared correctly.' }) };
        }

        // --- Call Gemini API ---
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

        // --- Return Response to Frontend ---
        return {
            statusCode: 200,
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(result),
        };

    } catch (error) {
        console.error('Server-side error:', error);
        return { statusCode: 500, body: JSON.stringify({ error: error.message || 'An internal server error occurred.' }) };
    }
};


// --- Helper function to get all file content from a Drive folder ---
async function getKnowledgeFromDrive(drive, folderId) {
    const res = await drive.files.list({
        q: `'${folderId}' in parents and trashed = false`,
        fields: 'files(id, name, mimeType)',
    });

    const files = res.data.files;
    if (files.length === 0) {
        return '';
    }

    const filePromises = files.map(async (file) => {
        const fileStream = await drive.files.get({ fileId: file.id, alt: 'media' }, { responseType: 'stream' });
        const pipeline = util.promisify(stream.pipeline);
        const chunks = [];
        const writable = new stream.Writable({
            write(chunk, encoding, callback) {
                chunks.push(chunk);
                callback();
            }
        });
        await pipeline(fileStream.data, writable);
        const buffer = Buffer.concat(chunks);

        // Parse content based on file type
        if (file.mimeType === 'application/pdf') {
            const data = await pdf(buffer);
            return data.text;
        } else if (file.mimeType === 'application/vnd.openxmlformats-officedocument.wordprocessingml.document') {
            const { value } = await mammoth.extractRawText({ buffer });
            return value;
        } else if (file.mimeType === 'application/vnd.openxmlformats-officedocument.presentationml.presentation') {
            const zip = await JSZip.loadAsync(buffer);
            const slidePromises = [];
            zip.folder("ppt/slides").forEach((relativePath, file) => {
                if (relativePath.endsWith('.xml')) {
                    slidePromises.push(file.async("string"));
                }
            });
            const slideXmls = await Promise.all(slidePromises);
            return slideXmls.map(xml => (xml.match(/<a:t>.*?<\/a:t>/g) || []).map(tag => tag.replace(/<.*?>/g, "")).join(' ')).join('\n');
        }
        return `Unsupported file type: ${file.name}`;
    });

    const allTexts = await Promise.all(filePromises);
    return allTexts.join('\n\n---\n\n');
}
