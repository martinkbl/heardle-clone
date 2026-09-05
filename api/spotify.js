const https = require('https');

function fetchHttp(url, options = {}) {
    return new Promise((resolve, reject) => {
        const req = https.get(url, {
            headers: {
                'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
                'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/webp,*/*;q=0.8',
                'Accept-Language': 'en-US,en;q=0.5',
                ...options.headers
            }
        }, (res) => {
            // Handle redirects
            if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
                return fetchHttp(res.headers.location, options).then(resolve).catch(reject);
            }

            let data = '';
            res.on('data', chunk => data += chunk);
            res.on('end', () => {
                if (res.statusCode >= 200 && res.statusCode < 300) {
                    resolve(data);
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

function extractSpotifyPlaylistId(input) {
    if (!input) return '';
    let val = input.trim();
    if (val.includes('/playlist/')) {
        val = val.split('/playlist/')[1];
    } else if (val.includes('spotify:playlist:')) {
        val = val.split('spotify:playlist:')[1];
    }
    if (val.includes('?')) {
        val = val.split('?')[0];
    }
    if (val.includes('&')) {
        val = val.split('&')[0];
    }
    if (val.includes('/')) {
        val = val.split('/')[0];
    }
    return val.trim();
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
    const playlistId = extractSpotifyPlaylistId(url || id);

    if (!playlistId || playlistId.length < 5) {
        return res.status(400).json({
            error: 'Invalid or missing Spotify playlist URL or ID.'
        });
    }

    try {
        // Fetch Spotify Embed page
        const embedUrl = `https://open.spotify.com/embed/playlist/${playlistId}`;
        const html = await fetchHttp(embedUrl);

        // Extract Next.js embedded data
        const nextDataMatch = html.match(/<script id="__NEXT_DATA__" type="application\/json">(.*?)<\/script>/s);
        let playlistName = '';
        let songs = [];

        if (nextDataMatch && nextDataMatch[1]) {
            try {
                const nextData = JSON.parse(nextDataMatch[1]);
                const entity = nextData.props?.pageProps?.state?.data?.entity;
                if (entity) {
                    playlistName = entity.name || entity.title || 'Spotify Playlist';
                    const trackList = entity.trackList || [];
                    songs = trackList.map(item => {
                        let title = (item.title || 'Unknown Title').replace(/\u00a0/g, ' ').trim();
                        let artist = (item.subtitle || 'Unknown Artist').replace(/\u00a0/g, ' ').trim();

                        // Basic clean up
                        title = title
                            .replace(/[\(\[\{].*?[\)\]\}]/g, '')
                            .replace(/Official Video/gi, '')
                            .replace(/Official Audio/gi, '')
                            .replace(/Lyrics/gi, '')
                            .replace(/ft\./gi, '')
                            .replace(/feat\./gi, '')
                            .replace(/,/g, '')
                            .trim();

                        return {
                            id: null, // to be resolved on demand with YouTube search
                            title: title,
                            artist: artist,
                            spotifyUri: item.uri || null,
                            audioPreviewUrl: item.audioPreview?.url || null,
                            source: 'spotify'
                        };
                    }).filter(s => s.title && s.artist);
                }
            } catch (err) {
                console.warn('Error parsing __NEXT_DATA__:', err.message);
            }
        }

        // Fallback: regex search if NEXT_DATA had a different structure
        if (songs.length === 0) {
            const titleMatch = html.match(/<title>(.*?)<\/title>/);
            if (titleMatch) {
                playlistName = titleMatch[1].replace(' | Spotify', '').replace('Spotify Embed - ', '').trim();
            }
        }

        if (songs.length === 0) {
            return res.status(404).json({
                error: 'Could not find any songs in this Spotify playlist. Make sure the playlist is public.'
            });
        }

        return res.status(200).json({
            success: true,
            id: playlistId,
            name: playlistName || 'Spotify Playlist',
            source: 'spotify',
            songs: songs
        });

    } catch (error) {
        console.error('Spotify fetch error:', error);
        return res.status(500).json({
            error: `Failed to fetch Spotify playlist: ${error.message}`
        });
    }
};
