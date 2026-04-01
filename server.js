const express = require('express');
const { exec } = require('child_process');
const app = express();
const port = process.env.PORT || 3000;

app.get('/get', (req, res) => {
  const url = req.query.url;
  if (!url) {
    return res.status(400).send({ error: 'Missing url parameter' });
  }

  exec(`yt-dlp -g "${url}"`, (error, stdout, stderr) => {
    if (error) {
      console.error(`Error: ${error}`);
      return res.status(500).send({ error: error.message });
    }
    const directUrl = stdout.trim();
    if (!directUrl) {
      return res.status(500).send({ error: 'No URL returned' });
    }
    res.send({ url: directUrl });
  });
});

app.listen(port, () => {
  console.log(`Proxy server running on port ${port}`);
});