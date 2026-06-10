// YouTube API Configuration
// Replace 'YOUR_API_KEY_HERE' with your actual YouTube Data API key
const YOUTUBE_CONFIG = {
    CLIENT_ID: 'YOUR_CLIENT_ID_HERE',
    API_KEY: 'YOUR_API_KEY_HERE', // Replace with your API key from Google Cloud Console
    DISCOVERY_DOCS: ['https://www.googleapis.com/discovery/v1/apis/youtube/v3/rest'],
    SCOPES: 'https://www.googleapis.com/auth/youtube.readonly'
};

// Instructions:
// 1. Go to Google Cloud Console > APIs & Services > Credentials
// 2. Click "Create Credentials" > "API Key"
// 3. Select "YouTube Data API v3"
// 4. Copy the generated API key and replace 'YOUR_API_KEY_HERE' above
// 5. Optionally restrict the key to YouTube Data API v3 and localhost:8000 