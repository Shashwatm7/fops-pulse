import dotenv from 'dotenv';
import axios from 'axios';

dotenv.config({ path: '/Users/shashwatmalik/fops-pulse/.env' });

async function test() {
    try {
        const response = await axios.get(
            `https://generativelanguage.googleapis.com/v1beta/models?key=${process.env.GEMINI_API_KEY}`
        );
        const models = response.data.models.filter(m => m.supportedGenerationMethods.includes('generateContent'));
        console.log("Available embedding models:");
        models.forEach(m => console.log(m.name, m.supportedGenerationMethods));
    } catch (err) {
        console.error("Failed:", err.response?.data || err.message);
    }
}
test();
