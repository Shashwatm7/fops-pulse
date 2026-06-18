import axios from 'axios';
import dotenv from 'dotenv';
dotenv.config();

const key = process.env.GEMINI_API_KEY;

async function run() {
    try {
        const url = `https://generativelanguage.googleapis.com/v1beta/models?key=${key}`;
        const { data } = await axios.get(url);
        for (const m of data.models) {
            if (m.name.includes('embed') || (m.supportedGenerationMethods && m.supportedGenerationMethods.includes('embedContent'))) {
                console.log(m.name, m.supportedGenerationMethods);
            }
        }
    } catch (err) {
        console.log(err.message);
    }
}
run();
