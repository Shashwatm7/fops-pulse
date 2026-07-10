import express from 'express';
const app = express();
app.get('/', (req, res) => {
    res.sendFile('/tmp/doesnotexist.html');
});
app.listen(3199, '0.0.0.0', () => console.log('started'));
