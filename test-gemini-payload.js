import axios from 'axios';
async function test() {
  try {
    const res = await axios.post('https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent?key=DUMMY_KEY', {
      system_instruction: { parts: [{ text: "test" }] },
      contents: [{ parts: [{ text: "test" }] }]
    });
  } catch (e) {
    console.error(e.response?.data || e.message);
  }
}
test();
