const askButton = document.getElementById('ask-button');
const userQuestionInput = document.getElementById('user-question');
const answerText = document.getElementById('answer-text');
const answerPlaceholder = document.getElementById('answer-placeholder');
const loader = document.getElementById('loader');
const errorMessage = document.getElementById('error-message');
const API_ENDPOINT = '/api/ask-gemini';

function showLoading() {
    loader.classList.remove('hidden');
    answerText.textContent = '';
    answerPlaceholder.classList.add('hidden');
    errorMessage.classList.add('hidden');
}

function hideLoading() {
    loader.classList.add('hidden');
}

function displayError(message) {
    hideLoading();
    errorMessage.textContent = `Error: ${message}`;
    errorMessage.classList.remove('hidden');
    answerPlaceholder.classList.remove('hidden');
}

async function handleAsk() {
    const userQuestion = userQuestionInput.value.trim();
    if (!userQuestion) {
        displayError("Please ask a question.");
        return;
    }

    showLoading();

    try {
        const response = await fetch(API_ENDPOINT, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ userQuestion })
        });

        const result = await response.json();

        if (!response.ok) {
            throw new Error(result.error || `Request failed with status ${response.status}`);
        }

        const generatedText = result.candidates?.[0]?.content?.parts?.[0]?.text;

        if (generatedText) {
            hideLoading();
            answerText.textContent = generatedText;
        } else {
            const finishReason = result.candidates?.[0]?.finishReason;
            if (finishReason === 'SAFETY') {
                 displayError("The response was blocked due to safety settings. Try rephrasing your question.");
            } else {
                 displayError("Could not get a valid answer from the AI. The response was empty.");
            }
        }
    } catch (error) {
        console.error("API call failed:", error);
        displayError(error.message || "An unknown error occurred.");
    }
}

askButton.addEventListener('click', handleAsk);
userQuestionInput.addEventListener('keyup', (event) => {
    if (event.key === 'Enter') {
        handleAsk();
    }
});