const https = require('https');
const http = require('http');

function fetchHttp(url, options = {}) {
    return new Promise((resolve, reject) => {
        const client = url.startsWith('https') ? https : http;
        const req = client.get(url, {
            headers: {
                'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
                'Accept': 'application/json,text/html,*/*',
                'Accept-Language': 'fr,en-US;q=0.9,en;q=0.8',
                ...options.headers
            }
        }, (res) => {
            // Handle redirects (e.g. deezer.page.link shortlinks)
            if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
                return fetchHttp(res.headers.location, options).then(resolve).catch(reject);
            }

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
        req.setTimeout(10000, () => {
            req.destroy();
            reject(new Error('Request timed out'));
        });
    });
}

async function extractDeezerPlaylistId(input) {
    if (!input) return '';
    let val = input.trim();

    // If it's a shortlink, resolve redirect to get real URL
    if (val.includes('deezer.page.link') || val.includes('dzr.page.link')) {
        try {
            const resolved = await new Promise((resolve) => {
                const req = https.get(val, { headers: { 'User-Agent': 'Mozilla/5.0' } }, (res) => {
                    if (res.headers.location) {
                        resolve(res.headers.location);
                    } else {
                        resolve(val);
                    }
                });
                req.on('error', () => resolve(val));
                req.setTimeout(5000, () => { req.destroy(); resolve(val); });
            });
            val = resolved;
        } catch (e) {
            console.warn('Error resolving shortlink:', e);
        }
    }

    if (val.includes('/playlist/')) {
        val = val.split('/playlist/')[1];
    }
    if (val.includes('?')) val = val.split('?')[0];
    if (val.includes('&')) val = val.split('&')[0];
    if (val.includes('/')) val = val.split('/')[0];
    if (val.includes('#')) val = val.split('#')[0];

    return val.trim();
}

function cleanSongTitle(title) {
    return (title || 'Unknown Title')
        .replace(/[\(\[\{].*?[\)\]\}]/g, '')
        .replace(/Official Video/gi, '')
        .replace(/Official Audio/gi, '')
        .replace(/Lyrics/gi, '')
        .replace(/ft\./gi, '')
        .replace(/feat\./gi, '')
        .replace(/,/g, '')
        .trim();
}

module.exports = async (req, res) => {
    // Enable CORS
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

    if (req.method === 'OPTIONS') {
        return res.status(200).end();
    }

    const { url, id } = req.query;
    const rawInput = url || id;
    const playlistId = await extractDeezerPlaylistId(rawInput);

    if (!playlistId || !/^\d+$/.test(playlistId)) {
        return res.status(400).json({
            error: 'Invalid or missing Deezer playlist URL or numeric ID.'
        });
    }

    try {
        const apiUrl = `https://api.deezer.com/playlist/${encodeURIComponent(playlistId)}?limit=100`;
        const data = await fetchHttp(apiUrl);

        if (data.error) {
            return res.status(404).json({
                error: data.error.message || 'Deezer playlist not found or private.'
            });
        }

        const playlistName = data.title || 'Deezer Playlist';
        const tracksData = (data.tracks && data.tracks.data) ? data.tracks.data : [];

        const songs = tracksData.map(item => {
            const rawTitle = item.title_short || item.title || 'Unknown Title';
            const rawArtist = (item.artist && item.artist.name) ? item.artist.name : 'Unknown Artist';

            return {
                id: null, // to be matched with YouTube audio on demand
                title: cleanSongTitle(rawTitle),
                artist: rawArtist.trim(),
                audioPreviewUrl: item.preview || null,
                deezerId: item.id || null,
                source: 'deezer'
            };
        }).filter(s => s.title && s.artist);

        if (songs.length === 0) {
            return res.status(404).json({
                error: 'No songs found in this Deezer playlist. Make sure the playlist is public.'
            });
        }

        return res.status(200).json({
            success: true,
            id: playlistId,
            name: playlistName,
            source: 'deezer',
            songs: songs
        });

    } catch (error) {
        console.error('Deezer fetch error:', error);
        return res.status(500).json({
            error: `Failed to fetch Deezer playlist: ${error.message}`
        });
    }
};
