const chatWindow = document.getElementById('chat-window');
const chatForm = document.getElementById('chat-form');
const userInput = document.getElementById('user-input');
const sendButton = document.getElementById('send-button');
const typingIndicator = document.getElementById('typing-indicator');
const errorMessage = document.getElementById('error-message');
const API_ENDPOINT = '/api/ask-gemini';

// --- State Management ---
let chatHistory = []; // Stores the conversation { role: 'user'/'model', parts: [{ text: '...' }] }

// --- Event Listeners ---
chatForm.addEventListener('submit', handleSendMessage);

// --- Functions ---
function handleSendMessage(e) {
    e.preventDefault();
    const message = userInput.value.trim();
    if (!message) return;

    // Add user message to history and UI
    chatHistory.push({ role: 'user', parts: [{ text: message }] });
    appendMessage(message, 'user');

    userInput.value = '';
    userInput.focus();

    // Get bot response
    fetchBotResponse();
}

function appendMessage(text, type) {
    const messageDiv = document.createElement('div');
    messageDiv.classList.add(type === 'user' ? 'user-message' : 'bot-message');
    
    const p = document.createElement('p');
    p.textContent = text;
    messageDiv.appendChild(p);
    
    chatWindow.appendChild(messageDiv);
    chatWindow.scrollTop = chatWindow.scrollHeight; // Auto-scroll to bottom
}

function showTypingIndicator(show) {
    typingIndicator.classList.toggle('hidden', !show);
    if (show) chatWindow.scrollTop = chatWindow.scrollHeight;
}

function displayError(message) {
    errorMessage.textContent = `Error: ${message}`;
    errorMessage.classList.remove('hidden');
}

async function fetchBotResponse() {
    showTypingIndicator(true);
    errorMessage.classList.add('hidden');

    try {
        const response = await fetch(API_ENDPOINT, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ chatHistory }) // Send the entire history
        });

        if (!response.ok) {
            const result = await response.json();
            throw new Error(result.error || `Request failed with status ${response.status}`);
        }

        const result = await response.json();
        const botMessage = result.candidates?.[0]?.content?.parts?.[0]?.text;

        if (botMessage) {
            // Add bot response to history and UI
            chatHistory.push({ role: 'model', parts: [{ text: botMessage }] });
            appendMessage(botMessage, 'bot');
        } else {
            throw new Error("Received an empty response from the bot.");
        }

    } catch (error) {
        console.error("API call failed:", error);
        displayError(error.message || "An unknown error occurred.");
    } finally {
        showTypingIndicator(false);
    }
}
