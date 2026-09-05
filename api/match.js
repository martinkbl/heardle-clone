const https = require('https');

function fetchHttp(url, options = {}) {
    return new Promise((resolve, reject) => {
        const req = https.get(url, {
            headers: {
                'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)',
                'Referer': 'https://heardle-clone-delta.vercel.app/',
                ...options.headers
            }
        }, (res) => {
            let data = '';
            res.on('data', chunk => data += chunk);
            res.on('end', () => {
                if (res.statusCode >= 200 && res.statusCode < 300) {
                    try {
                        resolve(JSON.parse(data));
                    } catch (e) {
                        resolve(data);
                    }
                } else {
                    reject(new Error(`HTTP ${res.statusCode}: ${data.slice(0, 100)}`));
                }
            });
        });

        req.on('error', reject);
        req.setTimeout(8000, () => {
            req.destroy();
            reject(new Error('Request timed out'));
        });
    });
}

module.exports = async (req, res) => {
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

    if (req.method === 'OPTIONS') {
        return res.status(200).end();
    }

    const query = req.query.q || req.query.query;
    if (!query) {
        return res.status(400).json({ error: 'Missing query parameter q' });
    }

    const apiKey = process.env.YOUTUBE_API_KEY || 'AIzaSyDA4eTxUyaC8s8rHlOp4AjKNqjycDljte4';

    try {
        const searchUrl = `https://www.googleapis.com/youtube/v3/search?part=snippet&q=${encodeURIComponent(query)}&type=video&maxResults=1&key=${encodeURIComponent(apiKey)}`;
        const data = await fetchHttp(searchUrl);

        if (data && data.items && data.items.length > 0) {
            const item = data.items[0];
            return res.status(200).json({
                success: true,
                videoId: item.id?.videoId || null,
                title: item.snippet?.title || '',
                channel: item.snippet?.channelTitle || ''
            });
        }

        return res.status(404).json({
            error: 'No matching YouTube video found.'
        });
    } catch (err) {
        console.error('Match audio error:', err);
        return res.status(500).json({
            error: `Failed to search YouTube: ${err.message}`
        });
    }
};
