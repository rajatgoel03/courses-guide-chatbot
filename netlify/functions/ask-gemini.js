const { google } = require('googleapis');
const stream = require('stream');
const util = require('util');

// Libraries for parsing file content
const pdf = require('pdf-parse');
const mammoth = require('mammoth');
const JSZip = require('jszip');

// Main handler for the Netlify serverless function
exports.handler = async function(event) {
    console.log("ask-openai function invoked.");

    if (event.httpMethod !== 'POST') {
        return { statusCode: 405, body: JSON.stringify({ error: 'Method Not Allowed' }) };
    }

    try {
        // --- Retrieve and Validate Environment Variables ---
        console.log("Step 1: Validating environment variables...");
        // NOTE: We now look for OPENAI_API_KEY instead of GEMINI_API_KEY
        const { OPENAI_API_KEY, DRIVE_API_CREDENTIALS, DRIVE_FOLDER_ID } = process.env;
        if (!OPENAI_API_KEY) throw new Error("Server configuration error: OPENAI_API_KEY is missing.");
        if (!DRIVE_API_CREDENTIALS) throw new Error("Server configuration error: DRIVE_API_CREDENTIALS is missing.");
        if (!DRIVE_FOLDER_ID) throw new Error("Server configuration error: DRIVE_FOLDER_ID is missing.");
        console.log("Environment variables are present.");

        let credentials;
        try {
            credentials = JSON.parse(DRIVE_API_CREDENTIALS);
        } catch (e) {
            throw new Error("Server configuration error: DRIVE_API_CREDENTIALS is not valid JSON.");
        }
        
        // --- Authenticate and Connect to Google Drive ---
        console.log("Step 2: Authenticating with Google Drive...");
        const auth = new google.auth.GoogleAuth({
            credentials,
            scopes: ['https://www.googleapis.com/auth/drive.readonly'],
        });
        const drive = google.drive({ version: 'v3', auth });
        console.log("Authentication successful.");

        // --- Fetch and Parse Files from Drive ---
        console.log("Step 3: Fetching and parsing files from Drive...");
        const knowledgeBase = await getKnowledgeFromDrive(drive, DRIVE_FOLDER_ID);
        if (!knowledgeBase) {
            throw new Error('Could not retrieve any content from the Google Drive folder.');
        }
        console.log(`File parsing complete. Knowledge base length: ${knowledgeBase.length}`);

        // --- Prepare and Call OpenAI (ChatGPT) API ---
        console.log("Step 4: Preparing to call OpenAI API...");
        const { userQuestion } = JSON.parse(event.body);
        if (!userQuestion) throw new Error('No user question was provided.');

        const systemPrompt = `You are a helpful university course assistant named 'Courses Guide'. Your job is to answer student questions based ONLY on the provided course information from the documents. If the answer is not found, you must say "I'm sorry, I don't have information on that." Do not make up answers. Here is the course information:\n\n---\n${knowledgeBase}\n---`;
        
        const API_URL = 'https://api.openai.com/v1/chat/completions';
        const payload = {
            model: "gpt-3.5-turbo", // You can also use "gpt-4" if you have access
            messages: [
                { role: "system", content: systemPrompt },
                { role: "user", content: userQuestion }
            ]
        };
        
        console.log("Sending request to OpenAI...");
        const openaiResponse = await fetch(API_URL, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'Authorization': `Bearer ${OPENAI_API_KEY}`
            },
            body: JSON.stringify(payload)
        });
        console.log(`Received response from OpenAI. Status: ${openaiResponse.status}`);

        if (!openaiResponse.ok) {
            const errorData = await openaiResponse.json();
            throw new Error(errorData.error?.message || 'Failed to fetch from OpenAI API.');
        }

        const result = await openaiResponse.json();
        const generatedText = result.choices?.[0]?.message?.content;

        // --- Return Successful Response to Frontend ---
        console.log("Step 5: Sending successful response to frontend.");
        // We format the response to match what the frontend expects, so no frontend changes are needed.
        return {
            statusCode: 200,
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                candidates: [{
                    content: {
                        parts: [{ text: generatedText }]
                    }
                }]
            }),
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

// --- Helper function to get all file content from a Drive folder (no changes needed here) ---
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
