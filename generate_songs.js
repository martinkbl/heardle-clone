require('dotenv').config();
const axios = require('axios');
const fs = require('fs');
const path = require('path');

// Configuration
// You can set these in a .env file or hardcode them here temporarily
const API_KEY = process.env.YOUTUBE_API_KEY; 
const PLAYLIST_ID = process.env.YOUTUBE_PLAYLIST_ID;
const OUTPUT_FILE = 'songs.json';

if (!API_KEY) {
    console.error('❌ Error: YOUTUBE_API_KEY is missing. Please set it in .env file.');
    process.exit(1);
}

if (!PLAYLIST_ID) {
    console.error('❌ Error: YOUTUBE_PLAYLIST_ID is missing. Please set it in .env file.');
    process.exit(1);
}

const YOUTUBE_API_URL = 'https://www.googleapis.com/youtube/v3/playlistItems';

async function fetchAllPlaylistItems() {
    let allItems = [];
    let nextPageToken = '';
    let pageCount = 0;

    console.log(`🎵 Starting fetch for Playlist ID: ${PLAYLIST_ID}`);

    try {
        do {
            pageCount++;
            console.log(`   Fetching page ${pageCount}...`);

            const response = await axios.get(YOUTUBE_API_URL, {
                params: {
                    part: 'snippet,contentDetails',
                    maxResults: 50,
                    playlistId: PLAYLIST_ID,
                    key: API_KEY,
                    pageToken: nextPageToken
                }
            });

            const items = response.data.items;
            if (!items || items.length === 0) {
                console.log('   No more items found.');
                break;
            }

            // Extract relevant data
            const cleanItems = items.map(item => {
                const snippet = item.snippet;
                const videoId = item.contentDetails.videoId;
                
                // Basic cleanup of titles to make them harder to guess
                let title = snippet.title;
                let artist = snippet.videoOwnerChannelTitle || "Unknown Artist";

                // Try to parse "Artist - Title" format common in music videos
                if (title.includes(' - ')) {
                    const parts = title.split(' - ');
                    artist = parts[0].trim();
                    title = parts.slice(1).join(' - ').trim();
                }

                // Remove common noise from titles
                title = title
                    .replace(/[\(\[\{].*?[\)\]\}]/g, '') // Remove (...) [...] {...}
                    .replace(/Official Video/gi, '')
                    .replace(/Official Audio/gi, '')
                    .replace(/Lyrics/gi, '')
                    .replace(/ft\./gi, '')
                    .replace(/feat\./gi, '')
                    .replace(/,/g, '') // remove commas to avoid csv weirdness if we ever use csv
                    .trim();

                return {
                    id: videoId,
                    title: title,
                    artist: artist,
                    original_title: snippet.title, // Keep original just in case
                    thumbnail: snippet.thumbnails?.high?.url || snippet.thumbnails?.default?.url
                };
            }).filter(song => song.title !== 'Private video' && song.title !== 'Deleted video');

            allItems = allItems.concat(cleanItems);
            nextPageToken = response.data.nextPageToken;

        } while (nextPageToken);

        console.log(`✅ Success! Fetched ${allItems.length} songs.`);
        
        // Save to file
        fs.writeFileSync(OUTPUT_FILE, JSON.stringify(allItems, null, 2));
        console.log(`💾 Saved to ${OUTPUT_FILE}`);

        // Save fallback JS file for file:// protocol compatibility
        const jsContent = `// Fallback song list for file:// compatibility\nwindow.HEARDLE_SONGS = ${JSON.stringify(allItems, null, 2)};\n`;
        fs.writeFileSync('songs.js', jsContent);
        console.log(`💾 Saved to songs.js`);

    } catch (error) {
        console.error('❌ Error fetching playlist:', error.message);
        if (error.response) {
            console.error('   API Error Details:', error.response.data);
        }
    }
}

fetchAllPlaylistItems();
