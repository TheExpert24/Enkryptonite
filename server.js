const express = require('express')
const { v4: uuidv4 } = require('uuid')
const http = require('http')
const https = require('https')
const WebSocket = require('ws')
const fs = require('fs')
const path = require('path')
const crypto = require('crypto')
const { MongoClient } = require('mongodb')
const multer = require('multer')
const { getDefaultAutoSelectFamily } = require('net')
const { ObjectId } = require('mongodb')
require('dotenv').config()

const app = express()

// Create server based on environment
let server;
if (process.env.NODE_ENV === 'production') {
    // In production (e.g. Render), the SSL/TLS is handled by the platform
    server = http.createServer(app)
} else {
    // For local development, use regular HTTP
    server = http.createServer(app)
}

const wss = new WebSocket.Server({ 
    server,
    // Handle both upgrade events for ws and wss
    handleProtocols: (protocols, req) => {
        return protocols[0]
    }
})

// Initialize chats and users from file if they exist
let chats = new Map()
let users = new Map()
let userKeys = new Map() // Store user public keys in memory for fast access

// Use Render's persistent storage in production, local storage in development
const DATA_DIR = process.env.NODE_ENV === 'production' 
    ? '/opt/render/project/src/data'
    : path.join(__dirname, 'data')

// Create data directory if it doesn't exist
if (!fs.existsSync(DATA_DIR)) {
    fs.mkdirSync(DATA_DIR, { recursive: true })
}

const CHATS_FILE = path.join(DATA_DIR, 'chats.json')
const USERS_FILE = path.join(DATA_DIR, 'users.json')

// MongoDB setup
const mongoUri = process.env.MONGODB_URI || 'mongodb://localhost:27017/chatapp';

// Use longer server-selection timeout and unified topology for Atlas SRV records
const client = new MongoClient(mongoUri, {
    useNewUrlParser: true,
    useUnifiedTopology: true,
    serverSelectionTimeoutMS: 20000 // 20s instead of default 30s
});

let db;

// Robust connect with automatic retry (handles DNS ETIMEOUT etc.)
async function connectDB(retries = Infinity, delayMs = 5000) {
    let attempt = 0;
    while (retries === Infinity || attempt < retries) {
        try {
            attempt++;
            console.log(`[MongoDB] Connecting (attempt ${attempt})…`);
            await client.connect();
            db = client.db();
            console.log('[MongoDB] Connected');

            // Create indexes for better query performance
            await db.collection('chats').createIndex({ createdAt: 1 });
            await db.collection('chats').createIndex({ name: 'text' });
            await db.collection('users').createIndex({ id: 1 }, { unique: true });
            return; // success
        } catch (err) {
            console.error('[MongoDB] Connection failed:', err.code || err.name || err.message);
            if (retries !== Infinity && attempt >= retries) {
                console.error('[MongoDB] Exhausted retries – starting server in file-only mode');
                return; // continue without DB
            }
            console.log(`[MongoDB] Retry in ${delayMs / 1000}s…`);
            await new Promise(res => setTimeout(res, delayMs));
        }
    }
}

function loadData() {
    try {
        if (fs.existsSync(CHATS_FILE)) {
            const data = JSON.parse(fs.readFileSync(CHATS_FILE, 'utf8'))
            chats = new Map(Object.entries(data))
            console.log(`Successfully loaded ${chats.size} chats from file`)
        } else {
            console.log('No existing chats file found, starting with empty chat list')
        }

        if (fs.existsSync(USERS_FILE)) {
            const data = JSON.parse(fs.readFileSync(USERS_FILE, 'utf8'))
            users = new Map(Object.entries(data))
            // Load public keys from user data into memory
            for (const [userId, userData] of users.entries()) {
                if (userData.publicKey) {
                    userKeys.set(userId, userData.publicKey)
                }
            }
            console.log(`Successfully loaded ${users.size} users from file`)
        } else {
            console.log('No existing users file found, starting with empty user list')
        }
    } catch (error) {
        console.error('Error loading data:', error)
        chats = new Map()
        users = new Map()
        userKeys = new Map()
    }
}

// Save data to files
function saveData() {
    try {
        const chatsData = Object.fromEntries(chats)
        fs.writeFileSync(CHATS_FILE, JSON.stringify(chatsData, null, 2))
        console.log(`Successfully saved ${chats.size} chats to file`)

        const usersData = Object.fromEntries(users)
        fs.writeFileSync(USERS_FILE, JSON.stringify(usersData, null, 2))
        console.log(`Successfully saved ${users.size} users to file`)
    } catch (error) {
        console.error('Error saving data:', error)
        // Try to create backups
        try {
            const timestamp = Date.now()
            if (fs.existsSync(CHATS_FILE)) {
                fs.copyFileSync(CHATS_FILE, `${CHATS_FILE}.backup-${timestamp}`)
            }
            if (fs.existsSync(USERS_FILE)) {
                fs.copyFileSync(USERS_FILE, `${USERS_FILE}.backup-${timestamp}`)
            }
            console.logn('Created backups of data files')
        } catch (backupError) {
            console.error('Failed to create backups:', backupError)
        }
    }
}

// Load data when server starts
loadData()

app.use(express.static('public'))
app.use(express.json())

// Ensure uploads directory exists
const UPLOADS_DIR = path.join(DATA_DIR, 'uploads');
if (!fs.existsSync(UPLOADS_DIR)) {
    fs.mkdirSync(UPLOADS_DIR, { recursive: true });
}

// Multer storage config for general files
const fileStorage = multer.diskStorage({
    destination: (req, file, cb) => {
        cb(null, UPLOADS_DIR);
    },
    filename: (req, file, cb) => {
        // Use timestamp + original name for uniqueness
        const uniqueName = Date.now() + '-' + file.originalname.replace(/[^a-zA-Z0-9.\-_]/g, '_');
        cb(null, uniqueName);
    }
});
const fileUpload = multer({ storage: fileStorage });

// File upload endpoint for all file types
app.post('/upload-file', fileUpload.single('file'), (req, res) => {
    if (!req.file) {
        return res.status(400).json({ error: 'No file uploaded' });
    }
    const fileUrl = `/uploads/${req.file.filename}`;
    res.json({ url: fileUrl, originalName: req.file.originalname });
});

// Configure multer for image uploads
const storage = multer.diskStorage({
    destination: function (req, file, cb) {
        cb(null, UPLOADS_DIR)
    },
    filename: function (req, file, cb) {
        const uniqueSuffix = Date.now() + '-' + Math.round(Math.random() * 1E9)
        cb(null, uniqueSuffix + path.extname(file.originalname))
    }
})

const upload = multer({
    storage: storage,
    limits: {
        fileSize: 5 * 1024 * 1024 // 5MB limit
    },
    fileFilter: function (req, file, cb) {
        // Accept only image files
        if (!file.originalname.match(/\.(jpg|jpeg|png|gif)$/)) {
            return cb(new Error('Only image files are allowed!'), false)
        }
        cb(null, true)
    }
})

// Serve uploaded files from the correct directory
app.use('/uploads', express.static(path.join(DATA_DIR, 'uploads')));

// Serve welcome.html as the default landing page
app.get('/', (req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'welcome.html'));
});

// Get all chats
app.get('/chats', (req, res) => {
    const chatList = Array.from(chats.entries()).map(([id, chat]) => ({
        id,
        name: chat.name,
        createdAt: chat.createdAt,
        messageCount: chat.messages.length
    }))
    res.json(chatList)
})

// Search chats
app.get('/search-chats', (req, res) => {
    const query = req.query.q?.toLowerCase() || '';
    
    if (!query) {
        return res.json([]);
    }

    const searchResults = Array.from(chats.entries())
        .map(([id, chat]) => {
            // Search in chat name
            const nameMatch = chat.name.toLowerCase().includes(query);
            
            // Search in messages
            const messageMatches = chat.messages.some(msg => 
                msg.content?.toLowerCase().includes(query)
            );

            // If either name or messages match, return the chat
            if (nameMatch || messageMatches) {
                return {
                    id,
                    name: chat.name,
                    createdAt: chat.createdAt,
                    messageCount: chat.messages.length,
                    // Include preview of matching messages
                    preview: messageMatches ? 
                        chat.messages
                            .filter(msg => msg.content?.toLowerCase().includes(query))
                            .map(msg => ({
                                content: msg.content,
                                sender: msg.sender,
                                timestamp: msg.timestamp
                            }))
                            .slice(0, 3) // Only show up to 3 matching messages
                        : []
                };
            }
            return null;
        })
        .filter(result => result !== null);

    res.json(searchResults);
});

// Delete a chat
app.delete('/api/chats/:chatId', async (req, res) => {
    try {
        const chatId = req.params.chatId;
        const userId = req.query.userId; // Get the user ID from query parameter
        
        if (!userId) {
            return res.status(400).json({ error: 'User ID is required' });
        }
        
        console.log('Attempting to delete chat:', chatId, 'by user:', userId);

        // First, check if the chat exists and get its creator
        const chat = await db.collection('chats').findOne({ id: chatId });
        
        if (!chat) {
            // Try finding by MongoDB _id for older records
            try {
                const objId = new ObjectId(chatId);
                const oldChat = await db.collection('chats').findOne({ _id: objId });
                if (!oldChat) {
                    return res.status(404).json({ error: 'Chat not found' });
                }
                // For older chats without creatorId, allow deletion (backward compatibility)
                console.log('Deleting older chat without creator tracking');
            } catch (err) {
                return res.status(404).json({ error: 'Chat not found' });
            }
        } else {
            // Check if the user is the creator of the chat
            if (chat.creatorId && chat.creatorId !== userId) {
                return res.status(403).json({ error: 'Only the chat creator can delete this chat' });
            }
        }

        // Try deleting by our custom id field first
        let result = await db.collection('chats').deleteOne({ id: chatId });

        // If not found, attempt deletion by MongoDB _id (covers older records)
        if (result.deletedCount === 0) {
            try {
                const objId = new ObjectId(chatId);
                result = await db.collection('chats').deleteOne({ _id: objId });
            } catch (err) {
                // chatId is not a valid ObjectId string – ignore
            }
        }

        if (result.deletedCount === 0) {
            return res.status(404).json({ error: 'Chat not found' });
        }

        console.log('Chat deleted successfully from MongoDB by user:', userId);
        res.status(200).json({ message: 'Chat deleted successfully' });
    } catch (error) {
        console.error('Error deleting chat:', error);
        res.status(500).json({ error: 'Failed to delete chat' });
    }
});

// Function to get recent chats (within last 24 hours)
function getRecentChats() {
    const twentyFourHoursAgo = Date.now() - (24 * 60 * 60 * 1000);
    const recentChats = [];
    
    for (const [id, chat] of chats.entries()) {
        if (chat.createdAt && chat.createdAt > twentyFourHoursAgo) {
            recentChats.push({
                id,
                name: chat.name,
                createdAt: chat.createdAt,
                // Calculate how long ago the chat was created
                timeAgo: getTimeAgo(chat.createdAt)
                });
            }
        }

    // Sort by newest first
    return recentChats.sort((a, b) => b.createdAt - a.createdAt);
}

// Helper function to format time ago
function getTimeAgo(timestamp) {
    const seconds = Math.floor((Date.now() - timestamp) / 1000);
    
    if (seconds < 60) return 'just now';
    
    const minutes = Math.floor(seconds / 60);
    if (minutes < 60) return `${minutes} minute${minutes !== 1 ? 's' : ''} ago`;
    
    const hours = Math.floor(minutes / 60);
    if (hours < 24) return `${hours} hour${hours !== 1 ? 's' : ''} ago`;
    
    return 'yesterday';
}

// Function to generate a unique ID
function generateUniqueId() {
    return crypto.randomBytes(16).toString('hex');
}

// Function to save chat metadata
function saveChatMetadata(chatId, chatData) {
    const chatDir = path.join(DATA_DIR, chatId);
    if (!fs.existsSync(chatDir)) {
        fs.mkdirSync(chatDir);
    }
    fs.writeFileSync(
        path.join(chatDir, 'metadata.json'),
        JSON.stringify(chatData, null, 2)
    );
}

// Function to load chat metadata
function loadChatMetadata(chatId) {
    const metadataPath = path.join(DATA_DIR, chatId, 'metadata.json');
    if (fs.existsSync(metadataPath)) {
        try {
            return JSON.parse(fs.readFileSync(metadataPath, 'utf8'));
        } catch (error) {
            console.error(`Error loading chat ${chatId}:`, error);
            return null;
        }
    }
    return null;
}

// Load existing chats on startup
function loadExistingChats() {
    console.log('Loading existing chats...');
    const chatDirs = fs.readdirSync(DATA_DIR);
    
    for (const chatId of chatDirs) {
        const metadata = loadChatMetadata(chatId);
        if (metadata) {
            chats.set(chatId, metadata);
            console.log(`Loaded chat: ${metadata.name} (created ${new Date(metadata.createdAt).toLocaleString()})`);
        }
    }
    console.log(`Loaded ${chats.size} chats`);
}

// Endpoint to find a private chat between multiple users
app.get('/api/private-chat', async (req, res) => {
    let members = req.query.members;
    if (!members) {
        // Fallback to old API for 2 users
    const { user1, user2 } = req.query;
    if (!user1 || !user2) {
            return res.status(400).json({ error: 'members or user1 and user2 are required' });
        }
        members = [user1, user2];
    } else {
        if (typeof members === 'string') {
            members = members.split(',').map(x => x.trim()).filter(Boolean);
        }
    }
    if (!Array.isArray(members) || members.length < 2) {
        return res.status(400).json({ error: 'At least 2 members required' });
    }
    try {
        // Find a chat that is private and has exactly these members
        const chat = await db.collection('chats').findOne({
            isPrivate: true,
            members: { $all: members, $size: members.length }
        });
        if (chat) {
            return res.json({ chatId: chat.id });
        } else {
            return res.json({ chatId: null });
        }
    } catch (error) {
        console.error('Error finding private chat:', error);
        res.status(500).json({ error: 'Failed to find private chat' });
    }
});

// Update create-chat endpoint to support private chats
app.post('/create-chat', async (req, res) => {
    const chatName = req.body.name;
    const isPrivate = req.body.isPrivate || false;
    const members = req.body.members || [];
    const creatorId = req.body.creatorId; // Add creator ID from request
    
    if (!chatName) {
        return res.status(400).json({ error: 'Chat name is required' });
    }
    // Moderation: Check if creator is banned
    if (await isUserBanned(creatorId)) {
        return res.status(403).json({ error: 'You are banned from creating chats.' });
    }
    // Moderation: Check for bad words in chat name
    if (containsBadWord(chatName)) {
        await banUser(creatorId, 'Inappropriate chat name');
        return res.status(400).json({ error: 'Chat name contains inappropriate language. You have been banned for 24 hours.' });
    }

    const chatId = generateUniqueId();
    const chat = {
        id: chatId,
        name: chatName,
        messages: [],
        createdAt: Date.now(),
        creatorId: creatorId, // Store the creator's ID
        isPrivate,
        members: Array.isArray(members) && members.length > 0 ? members : [] // Always initialize as array
    };
    try {
        await db.collection('chats').insertOne(chat);
        console.log(`Created new chat: ${chatName} (${chatId}) by user ${creatorId} at ${new Date(chat.createdAt).toLocaleString()}`);
        
        // Automatically star the chat for the creator
        if (creatorId) {
            try {
                await db.collection('users').updateOne(
                    { id: creatorId },
                    { $addToSet: { starredChats: chatId } }
                );
                console.log(`Automatically starred chat ${chatId} for creator ${creatorId}`);
            } catch (starError) {
                console.error('Error auto-starring chat for creator:', starError);
                // Don't fail the chat creation if starring fails
            }
        }
        
        res.json({ id: chatId, name: chatName });
    } catch (error) {
        console.error('Error creating chat:', error);
        res.status(500).json({ error: 'Failed to create chat' });
    }
});

// Get recent chats endpoint
app.get('/api/recent-chats', async (req, res) => {
    try {
        const twentyFourHoursAgo = Date.now() - (24 * 60 * 60 * 1000);
        
        const recentChats = await db.collection('chats')
            .find({ createdAt: { $gt: twentyFourHoursAgo }, $or: [{ isPrivate: { $exists: false } }, { isPrivate: false }] })
            .sort({ createdAt: -1 })
            .toArray();

        const formattedChats = recentChats.map(chat => ({
            id: chat.id,
            name: chat.name,
            createdAt: chat.createdAt,
            creatorId: chat.creatorId || null, // Include creator ID
            timeAgo: getTimeAgo(chat.createdAt)
        }));

        console.log(`Found ${formattedChats.length} recent chats (within last 24 hours)`);
        console.log('Recent chats:', formattedChats.map(chat => `${chat.name} (${chat.timeAgo})`));
        res.json(formattedChats);
    } catch (error) {
        console.error('Error getting recent chats:', error);
        res.status(500).json({ error: 'Failed to get recent chats' });
    }
});

// Search chats endpoint
app.get('/api/search-chats', async (req, res) => {
    try {
        const query = req.query.q?.toLowerCase() || '';
        if (!query) {
            return res.json([]);
        }

        const results = await db.collection('chats')
            .find({ name: { $regex: query, $options: 'i' }, $or: [{ isPrivate: { $exists: false } }, { isPrivate: false }] })
            .sort({ createdAt: -1 })
            .toArray();

        const formattedResults = results.map(chat => ({
            id: chat.id,
            name: chat.name,
            createdAt: chat.createdAt
        }));

        res.json(formattedResults);
    } catch (error) {
        console.error('Error searching chats:', error);
        res.status(500).json({ error: 'Failed to search chats' });
    }
});

// Load chats on startup
loadExistingChats();

// Add new endpoints for user management
app.post('/register-user', async (req, res) => {
    const { displayName, userId, profilePic } = req.body
    if (!displayName) {
        return res.status(400).json({ error: 'Name is required' })
    }
    // Moderation: Check for bad words in display name
    if (containsBadWord(displayName)) {
        return res.status(400).json({ error: 'Display name contains inappropriate language. Please choose another name.' })
    }
    // Moderation: If userId is provided, check if user is banned
    if (userId && await isUserBanned(userId)) {
        return res.status(403).json({ error: 'You are banned from registering.' })
    }

    const newUserId = userId || uuidv4()
    
    // Generate a random 4-digit code for display purposes (like Discord)
    const randomCode = Math.floor(1000 + Math.random() * 9000).toString()
    
    // Generate a random secret word (adjective + noun) for authentication
    const adjectives = ['mysterious', 'enchanted', 'whispering', 'golden', 'silver', 'crystal', 'shadow', 'bright', 'gentle', 'brave', 'clever', 'swift', 'noble', 'wise', 'bold', 'calm', 'deep', 'fair', 'free', 'kind', 'proud', 'pure', 'quiet', 'rare', 'rich', 'smooth', 'soft', 'strong', 'sweet', 'warm', 'wild', 'young', 'ancient', 'cosmic', 'eternal', 'hidden', 'magical', 'sacred', 'secret', 'timeless', 'wondrous']
    const nouns = ['mountain', 'ocean', 'forest', 'river', 'star', 'moon', 'sun', 'cloud', 'wind', 'fire', 'earth', 'water', 'light', 'shadow', 'dream', 'hope', 'love', 'peace', 'joy', 'wisdom', 'courage', 'strength', 'beauty', 'grace', 'honor', 'truth', 'freedom', 'harmony', 'serenity', 'tranquility', 'adventure', 'journey', 'quest', 'destiny', 'legacy', 'heritage', 'tradition', 'culture', 'spirit', 'soul', 'heart', 'mind', 'vision', 'inspiration', 'creativity', 'imagination', 'wonder', 'magic', 'mystery', 'enchantment', 'blessing', 'gift']
    
    const randomAdjective = adjectives[Math.floor(Math.random() * adjectives.length)]
    const randomNoun = nouns[Math.floor(Math.random() * nouns.length)]
    const secretWord = `${randomAdjective} ${randomNoun}`
    
    const fullDisplayName = `${displayName}#${randomCode}`
    
    try {
        const userData = {
            id: newUserId,
            name: displayName, // Store just the display name for messages
            fullName: fullDisplayName, // Store full name with code for profiles
            displayName: displayName, // Store original name without code
            code: randomCode, // Store the 4-digit code for display purposes
            createdAt: Date.now(),
            starredChats: [],
            secretWord: secretWord
        }
        
        if (profilePic) {
            userData.profilePic = profilePic
        }
        
        await db.collection('users').insertOne(userData)
        console.log(`Registered new user: ${fullDisplayName} (${newUserId})`)
        res.json({ userId: newUserId, displayName: displayName, profilePic: userData.profilePic || null })
    } catch (error) {
        console.error('Error registering user:', error)
        res.status(500).json({ error: 'Failed to register user' })
    }
})

app.get('/user/:userId', async (req, res) => {
    const { userId } = req.params
    console.log('Fetching user data for:', userId);
    try {
        const user = await db.collection('users').findOne({ id: userId })
        
        if (!user) {
            console.log('User not found:', userId);
            return res.status(404).json({ error: 'User not found' })
        }
        
        console.log('User found, formatting:', user.formatting);
        
        res.json({ 
            userId: user.id, 
            name: user.name, // Display name for messages
            fullName: user.fullName || user.name, // Full name with code for profiles
            displayName: user.displayName || user.name,
            code: user.code || null,
            secretWord: user.secretWord || null,
            profilePic: user.profilePic || null,
            formatting: user.formatting || null,
            bannedUntil: user.bannedUntil || null,
            banReason: user.banReason || null
        })
    } catch (error) {
        console.error('Error fetching user:', error)
        res.status(500).json({ error: 'Failed to fetch user' })
    }
})

// Star a chat for a user
app.post('/api/user/:userId/star', async (req, res) => {
    const { userId } = req.params;
    const { chatId } = req.body;
    if (!chatId) {
        return res.status(400).json({ error: 'chatId is required' });
    }
    try {
        const result = await db.collection('users').updateOne(
            { id: userId },
            { $addToSet: { starredChats: chatId } }
        );
        if (result.matchedCount === 0) {
            return res.status(404).json({ error: 'User not found' });
        }
        res.json({ success: true });
    } catch (error) {
        console.error('Error starring chat:', error);
        res.status(500).json({ error: 'Failed to star chat' });
    }
});

// Unstar a chat for a user
app.post('/api/user/:userId/unstar', async (req, res) => {
    const { userId } = req.params;
    const { chatId } = req.body;
    if (!chatId) {
        return res.status(400).json({ error: 'chatId is required' });
    }
    try {
        const result = await db.collection('users').updateOne(
            { id: userId },
            { $pull: { starredChats: chatId } }
        );
        if (result.matchedCount === 0) {
            return res.status(404).json({ error: 'User not found' });
        }
        res.json({ success: true });
    } catch (error) {
        console.error('Error unstarring chat:', error);
        res.status(500).json({ error: 'Failed to unstar chat' });
    }
});

// Get starred chats for a user
app.get('/api/user/:userId/starred-chats', async (req, res) => {
    const { userId } = req.params;
    try {
        const user = await db.collection('users').findOne({ id: userId });
        if (!user) {
            return res.status(404).json({ error: 'User not found' });
        }
        if (!user.starredChats || user.starredChats.length === 0) {
            return res.json([]);
        }

        const starredChats = await db.collection('chats').find({
            id: { $in: user.starredChats }
        }).toArray();
        
        res.json(starredChats);
    } catch (error) {
        console.error('Error fetching starred chats:', error);
        res.status(500).json({ error: 'Failed to fetch starred chats' });
    }
});

// Endpoint to update user name
app.post('/user/:userId/update-name', async (req, res) => {
    const { userId } = req.params;
    const { name } = req.body;
    if (!name) {
        return res.status(400).json({ error: 'Name is required' });
    }
    // Moderation: Check for bad words in new name
    if (containsBadWord(name)) {
        return res.status(400).json({ error: 'Name contains inappropriate language. Please choose another name.' });
    }
    // Moderation: Check if user is banned
    if (await isUserBanned(userId)) {
        return res.status(403).json({ error: 'You are banned from updating your name.' });
    }
    try {
        const result = await db.collection('users').updateOne(
            { id: userId },
            { $set: { name } }
        );
        if (result.matchedCount === 0) {
            return res.status(404).json({ error: 'User not found' });
        }
        res.json({ success: true, name });
    } catch (error) {
        console.error('Error updating user name:', error);
        res.status(500).json({ error: 'Failed to update user name' });
    }
});

// Endpoint to save user formatting preferences
app.post('/user/:userId/formatting', async (req, res) => {
    const { userId } = req.params;
    const formatting = req.body;
    
    console.log('Saving formatting for user:', userId, 'formatting:', formatting);
    
    if (!userId || !formatting) {
        console.log('Missing userId or formatting data');
        return res.status(400).json({ error: 'userId and formatting data are required' });
    }
    
    try {
        const result = await db.collection('users').updateOne(
            { id: userId },
            { $set: { formatting: formatting } }
        );
        
        console.log('Formatting save result:', result);
        
        if (result.matchedCount === 0) {
            console.log('User not found for formatting save:', userId);
            return res.status(404).json({ error: 'User not found' });
        }
        
        res.json({ success: true, message: 'Formatting preferences saved' });
    } catch (error) {
        console.error('Error saving formatting preferences:', error);
        res.status(500).json({ error: 'Failed to save formatting preferences' });
    }
});

// --- Spam Detection (in-memory, per user) ---
const userMessageTimestamps = new Map(); // userId -> [timestamps]
const userLastMessage = new Map(); // userId -> last message content

function isSpam(userId, content) {
    const now = Date.now();
    // Track timestamps
    if (!userMessageTimestamps.has(userId)) userMessageTimestamps.set(userId, []);
    const timestamps = userMessageTimestamps.get(userId);
    timestamps.push(now);
    // Keep only last 10 seconds
    while (timestamps.length && now - timestamps[0] > 10000) timestamps.shift();
    // More than 5 messages in 10 seconds
    if (timestamps.length > 5) return 'rate';
    // Repeated identical message
    const last = userLastMessage.get(userId);
    userLastMessage.set(userId, content);
    if (last && last === content) return 'repeat';
    // Excessive length
    if (content && content.length > 1000) return 'length';
    return false;
}

// WebSocket connection handling
wss.on('connection', async (ws) => {
    console.log('New WebSocket connection');
    let chatID;
    let userId;

    ws.on('message', async (message) => {
        try {
            const data = JSON.parse(message);
            console.log('Received WebSocket message:', data.type);

            // Moderation: Check ban on every message
            if (data.userId && await isUserBanned(data.userId)) {
                ws.send(JSON.stringify({ type: 'banned', reason: 'You are banned.', bannedUntil: (await db.collection('users').findOne({ id: data.userId })).bannedUntil }));
                ws.close();
                return;
            }

            if (data.type === 'join') {
                chatID = data.chatID;
                userId = data.userId;
                ws.chatID = chatID;
                ws.userId = userId;

                // Moderation: Check ban on join
                if (await isUserBanned(userId)) {
                    ws.send(JSON.stringify({ type: 'banned', reason: 'You are banned.', bannedUntil: (await db.collection('users').findOne({ id: userId })).bannedUntil }));
                    ws.close();
                    return;
                }

                const isTrial = data.trial === true;
                console.log(`User ${userId} joining chat ${chatID}${isTrial ? ' (trial)' : ''}`);

                // Load chat from MongoDB
                const chat = await db.collection('chats').findOne({ id: chatID });
                if (chat) {
                    // Ensure members field is an array
                    if (!Array.isArray(chat.members)) {
                        await db.collection('chats').updateOne(
                            { id: chatID },
                            { $set: { members: [] } }
                        );
                        chat.members = [];
                    }

                    // Only add to members list if NOT a trial connection
                    if (!isTrial && !chat.members.includes(userId)) {
                        await db.collection('chats').updateOne(
                            { id: chatID },
                            { $addToSet: { members: userId } }
                        );
                        chat.members.push(userId);
                    }

                    console.log(`Sending chat history for ${chat.name} (${chat.messages?.length || 0} messages)`);
                    ws.send(JSON.stringify({
                        type: 'history',
                        messages: chat.messages || [],
                        chatName: chat.name
                    }));
                }
            } else if (data.type === 'message') {
                // Moderation: Check for spam
                const spamType = isSpam(userId, data.content);
                if (spamType) {
                    let reason = 'Spam';
                    // Delete all recent messages from this user in this chat (last 10 seconds)
                    const now = Date.now();
                    const currentChat = await db.collection('chats').findOne({ id: chatID });
                    if (currentChat && Array.isArray(currentChat.messages)) {
                        const spamMsgIds = currentChat.messages
                            .filter(m => m.userId === userId && now - m.timestamp <= 10000)
                            .map(m => m.id);
                        if (spamMsgIds.length > 0) {
                            await db.collection('chats').updateOne(
                                { id: chatID },
                                { $pull: { messages: { id: { $in: spamMsgIds } } } }
                            );
                            // Broadcast deletion to all clients
                            wss.clients.forEach((client) => {
                                if (client.readyState === WebSocket.OPEN && client.chatID === chatID) {
                                    spamMsgIds.forEach(messageId => {
                                        client.send(JSON.stringify({
                                            type: 'message_deleted',
                                            messageId
                                        }));
                                    });
                                }
                            });
                        }
                    }
                    await banUser(userId, reason);
                    ws.send(JSON.stringify({ type: 'banned', reason, bannedUntil: Date.now() + 24*60*60*1000 }));
                    ws.close();
                    return;
                }
                // Moderation: Check for bad words in message
                if (containsBadWord(data.content)) {
                    await banUser(userId, 'Inappropriate message content');
                    ws.send(JSON.stringify({ type: 'banned', reason: 'Inappropriate message content. You have been banned for 24 hours.' }));
                    ws.close();
                    return;
                }
                // Add message to MongoDB
                const message = {
                    id: data.id || generateUniqueId(),
                    sender: data.sender,
                    content: data.content,
                    timestamp: Date.now(),
                    encrypted: data.encrypted,
                    userId: userId,
                    imageUrl: data.imageUrl, // Add support for image URLs
                    gifUrl: data.gifUrl, // Add support for GIF URLs
                    fileUrl: data.fileUrl, // Add support for file URLs
                    fileName: data.fileName, // Add support for file names
                    parentId: data.parentId || null // Add support for threads
                };

                // First get the current chat to preserve its name
                const currentChat = await db.collection('chats').findOne({ id: chatID });
                if (!currentChat) {
                    console.error('Chat not found:', chatID);
                    return;
                }

                await db.collection('chats').updateOne(
                    { id: chatID },
                    { 
                        $set: { name: currentChat.name },
                        $push: { messages: message }
                    }
                );
                
                // Broadcast to all clients except the sender
                wss.clients.forEach((client) => {
                    if (client !== ws && client.readyState === WebSocket.OPEN && client.chatID === chatID) {
                        client.send(JSON.stringify({
                            type: 'message',
                            message
                        }));
                    }
                });
            } else if (data.type === 'delete_message') {
                console.log(`Deleting message ${data.messageId} from chat ${chatID}`);
                
                // First get the current chat to preserve its name
                const currentChat = await db.collection('chats').findOne({ id: chatID });
                if (!currentChat) {
                    console.error('Chat not found:', chatID);
                    return;
                }

                // Find the message to verify ownership
                const messageToDelete = currentChat.messages.find(m => m.id === data.messageId);
                if (!messageToDelete) {
                    console.error('Message not found:', data.messageId);
                    return;
                }

                // Verify that the user is the sender of the message
                if (messageToDelete.userId !== userId) {
                    console.error('User not authorized to delete this message');
                    return;
                }

                // Remove message from MongoDB
                const result = await db.collection('chats').updateOne(
                    { id: chatID },
                    { 
                        $set: { name: currentChat.name },
                        $pull: { messages: { id: data.messageId } }
                    }
                );

                if (result.modifiedCount === 0) {
                    console.error('Failed to delete message from database');
                    return;
                }
                
                console.log('Message deleted successfully, broadcasting to all clients');
                
                // Broadcast deletion to all clients
                wss.clients.forEach((client) => {
                    if (client.readyState === WebSocket.OPEN && client.chatID === chatID) {
                        client.send(JSON.stringify({
                            type: 'message_deleted',
                            messageId: data.messageId
                        }));
                    }
                });
            } else if (data.type === 'typing') {
                // Broadcast typing event to all other clients in the same chat
                wss.clients.forEach((client) => {
                    if (
                        client !== ws &&
                        client.readyState === WebSocket.OPEN &&
                        client.chatID === data.chatID
                    ) {
                        client.send(JSON.stringify({
                            type: 'typing',
                            userId: data.userId
                        }));
                    }
                });
            } else if (data.type === 'react_message') {
                const { messageId, emoji, userId } = data;
                console.log(`User ${userId} reacted to message ${messageId} in chat ${chatID} with ${emoji}`);

                // Add reaction to MongoDB (push into reactions array on target message)
                try {
                    await db.collection('chats').updateOne(
                        { id: chatID, "messages.id": messageId },
                        {
                            $push: {
                                "messages.$.reactions": {
                                    emoji: emoji,
                                    userId: userId
                                }
                            }
                        }
                    );
                } catch (err) {
                    console.error('Failed to store reaction:', err);
                }

                // Broadcast reaction to all clients in this chat
                wss.clients.forEach((client) => {
                    if (client.readyState === WebSocket.OPEN && client.chatID === chatID) {
                        client.send(JSON.stringify({
                            type: 'reaction_added',
                            messageId: messageId,
                            emoji: emoji,
                            userId: userId
                        }));
                    }
                });
            } else if (data.type === 'remove_reaction') {
                console.log('[Reaction] Received remove_reaction', { messageId: data.messageId, emoji: data.emoji, userId: data.userId });
                const { messageId, emoji, userId } = data;
                console.log(`User ${userId} removed reaction ${emoji} from message ${messageId} in chat ${chatID}`);
                // Remove reaction from MongoDB
                try {
                    const dbResult = await db.collection('chats').updateOne(
                        { id: chatID, "messages.id": messageId },
                        {
                            $pull: {
                                "messages.$.reactions": {
                                    emoji: emoji,
                                    userId: userId
                                }
                            }
                        }
                    );
                    console.log('[Reaction] DB update result', dbResult);
                } catch (err) {
                    console.error('Failed to remove reaction:', err);
                }
                console.log('[Reaction] Broadcasting reaction_removed', { messageId, emoji, userId });
                // Broadcast reaction removal to all clients
                wss.clients.forEach((client) => {
                    if (client.readyState === WebSocket.OPEN && client.chatID === chatID) {
                        client.send(JSON.stringify({
                            type: 'reaction_removed',
                            messageId: messageId,
                            emoji: emoji,
                            userId: userId
                        }));
                    }
                });
            }
        } catch (error) {
            console.error('Error handling WebSocket message:', error);
        }
    });

    ws.on('close', () => {
        console.log(`WebSocket connection closed for user ${userId} in chat ${chatID}`);
    });
});

// Get chat messages endpoint
app.get('/api/chats/:chatId', async (req, res) => {
    try {
        const chatId = req.params.chatId;
        const chat = await db.collection('chats').findOne({ id: chatId });
        
        if (!chat) {
            return res.status(404).json({ error: 'Chat not found' });
        }
        
        res.json({
            id: chat.id,
            name: chat.name,
            messages: chat.messages || [],
            createdAt: chat.createdAt,
            creatorId: chat.creatorId || null, // Include creator ID
            members: chat.members || []
        });
    } catch (error) {
        console.error('Error getting chat:', error);
        res.status(500).json({ error: 'Failed to get chat' });
    }
});

// Get chat details endpoint
app.get('/api/chat/:chatId', async (req, res) => {
    try {
        const chatId = req.params.chatId;
        console.log('Fetching chat with ID:', chatId);
        
        const chat = await db.collection('chats').findOne({ id: chatId });
        console.log('Found chat:', chat ? `${chat.name} (${chat.id})` : 'null');
        
        if (!chat) {
            console.log('Chat not found in MongoDB');
            return res.status(404).json({ error: 'Chat not found' });
        }
        
        const response = {
            id: chat.id,
            name: chat.name,
            messages: chat.messages || [],
            createdAt: chat.createdAt,
            creatorId: chat.creatorId || null, // Include creator ID
            members: chat.members || [] // Always return members array
        };
        console.log('Sending chat data:', {
            id: response.id,
            name: response.name,
            messageCount: response.messages.length,
            createdAt: new Date(response.createdAt).toISOString(),
            membersCount: response.members.length
        });
        
        res.json(response);
    } catch (error) {
        console.error('Error getting chat:', error);
        res.status(500).json({ error: 'Failed to get chat' });
    }
});

// Add member to chat endpoint
app.post('/api/chat/:chatId/add-member', async (req, res) => {
    try {
        const chatId = req.params.chatId;
        const { userId } = req.body;
        
        if (!userId) {
            return res.status(400).json({ error: 'userId is required' });
        }
        
        console.log(`Adding user ${userId} to chat ${chatId}`);
        
        // First ensure the chat exists and members field is an array
        const chat = await db.collection('chats').findOne({ id: chatId });
        if (!chat) {
            return res.status(404).json({ error: 'Chat not found' });
        }
        
        // Ensure members field is an array
        if (!Array.isArray(chat.members)) {
            await db.collection('chats').updateOne(
                { id: chatId },
                { $set: { members: [] } }
            );
        }
        
        // Add user to members array if not already present
        const result = await db.collection('chats').updateOne(
            { id: chatId },
            { $addToSet: { members: userId } }
        );
        
        if (result.modifiedCount > 0) {
            console.log(`Successfully added user ${userId} to chat ${chatId}`);
            res.json({ success: true, message: 'User added to chat' });
        } else {
            console.log(`User ${userId} was already in chat ${chatId}`);
            res.json({ success: true, message: 'User already in chat' });
        }
    } catch (error) {
        console.error('Error adding member to chat:', error);
        res.status(500).json({ error: 'Failed to add member to chat' });
    }
});

// Remove member from chat endpoint
app.post('/api/chat/:chatId/remove-member', async (req, res) => {
    try {
        const chatId = req.params.chatId;
        const { userId } = req.body;
        if (!userId) {
            return res.status(400).json({ error: 'userId is required' });
        }

        console.log(`Removing user ${userId} from chat ${chatId}`);

        // Ensure chat exists
        const chat = await db.collection('chats').findOne({ id: chatId });
        if (!chat) {
            return res.status(404).json({ error: 'Chat not found' });
        }

        // Pull user from members array
        await db.collection('chats').updateOne(
            { id: chatId },
            { $pull: { members: userId } }
        );

        res.json({ success: true });
    } catch (err) {
        console.error('Error removing member from chat:', err);
        res.status(500).json({ error: 'Failed to remove member' });
    }
});

// Debug endpoint to list all chats in MongoDB
app.get('/api/debug/chats', async (req, res) => {
    try {
        const chats = await db.collection('chats').find({}).toArray();
        console.log('All chats in MongoDB:', chats.map(chat => ({
            id: chat.id,
            name: chat.name,
            creatorId: chat.creatorId || 'none',
            messageCount: chat.messages ? chat.messages.length : 0
        })));
        res.json(chats);
    } catch (error) {
        console.error('Error listing chats:', error);
        res.status(500).json({ error: 'Failed to list chats' });
    }
});

// Get all chats with pagination
app.get('/api/all-chats', async (req, res) => {
    try {
        const page = parseInt(req.query.page) || 1;
        const limit = parseInt(req.query.limit) || 10;
        const skip = (page - 1) * limit;

        // Get total count of chats (excluding private)
        const totalChats = await db.collection('chats').countDocuments({ $or: [{ isPrivate: { $exists: false } }, { isPrivate: false }] });
        
        // Get paginated chats (excluding private)
        const chats = await db.collection('chats')
            .find({ $or: [{ isPrivate: { $exists: false } }, { isPrivate: false }] })
            .sort({ createdAt: -1 })
            .skip(skip)
            .limit(limit)
            .toArray();

        res.json({
            chats: chats.map(chat => ({
                id: chat.id,
                name: chat.name,
                createdAt: chat.createdAt,
                creatorId: chat.creatorId || null
            })),
            hasMore: skip + chats.length < totalChats
        });
    } catch (error) {
        console.error('Error getting all chats:', error);
        res.status(500).json({ error: 'Failed to get chats' });
    }
});

// Add file upload endpoint
app.post('/upload-image', upload.single('image'), async (req, res) => {
    if (!req.file) {
        return res.status(400).json({ error: 'No file uploaded' })
    }

    try {
        const imageUrl = `/uploads/${req.file.filename}`
        res.json({ url: imageUrl })
    } catch (error) {
        console.error('Error uploading file:', error)
        res.status(500).json({ error: 'Failed to upload file' })
    }
})

// Endpoint to get all users (for private messaging)
app.get('/api/users', async (req, res) => {
    try {
        const users = await db.collection('users').find({}, { projection: { id: 1, name: 1, _id: 0 } }).toArray();
        res.json(users);
    } catch (error) {
        console.error('Error fetching users:', error);
        res.status(500).json({ error: 'Failed to fetch users' });
    }
});

// Endpoint to get all private chats for a user
app.get('/api/my-private-chats/:userId', async (req, res) => {
    const { userId } = req.params;
    try {
        const chats = await db.collection('chats')
            .find({ isPrivate: true, members: userId })
            .sort({ createdAt: -1 })
            .toArray();
        res.json(chats.map(chat => ({ 
            id: chat.id, 
            name: chat.name, 
            creatorId: chat.creatorId || null,
            members: chat.members, 
            createdAt: chat.createdAt 
        })));
    } catch (error) {
        console.error('Error fetching private chats:', error);
        res.status(500).json({ error: 'Failed to fetch private chats' });
    }
});

// Add multer for profile picture uploads
const profilePicStorage = multer.diskStorage({
    destination: function (req, file, cb) {
        const uploadDir = path.join(DATA_DIR, 'uploads', 'profile-pics');
        if (!fs.existsSync(uploadDir)) {
            fs.mkdirSync(uploadDir, { recursive: true });
        }
        cb(null, uploadDir);
    },
    filename: function (req, file, cb) {
        const uniqueSuffix = Date.now() + '-' + Math.round(Math.random() * 1E9);
        cb(null, uniqueSuffix + path.extname(file.originalname));
    }
});
const uploadProfilePic = multer({
    storage: profilePicStorage,
    limits: { fileSize: 5 * 1024 * 1024 }, // 5MB limit
    fileFilter: function (req, file, cb) {
        if (!file.originalname.match(/\.(jpg|jpeg|png|gif)$/i)) {
            return cb(new Error('Only image files are allowed!'), false);
        }
        cb(null, true);
    }
});

// Serve profile pictures
app.use('/uploads/profile-pics', express.static(path.join(DATA_DIR, 'uploads', 'profile-pics')));

// Endpoint to upload a profile picture for new users (no userId required)
app.post('/upload-profile-pic', uploadProfilePic.single('profilePic'), async (req, res) => {
    if (!req.file) {
        return res.status(400).json({ error: 'No file uploaded' });
    }
    try {
        const imageUrl = `/uploads/profile-pics/${req.file.filename}`;
        res.json({ url: imageUrl });
    } catch (error) {
        console.error('Error uploading profile picture:', error);
        res.status(500).json({ error: 'Failed to upload profile picture' });
    }
});

// Endpoint to upload a profile picture for a user
app.post('/upload-profile-pic/:userId', uploadProfilePic.single('profilePic'), async (req, res) => {
    const { userId } = req.params;
    if (!req.file) {
        return res.status(400).json({ error: 'No file uploaded' });
    }
    try {
        const imageUrl = `/uploads/profile-pics/${req.file.filename}`;
        await db.collection('users').updateOne(
            { id: userId },
            { $set: { profilePic: imageUrl } }
        );

        // Notify all connected clients that this user's profile picture changed
        try {
            wss.clients.forEach((client) => {
                if (client.readyState === WebSocket.OPEN) {
                    client.send(JSON.stringify({
                        type: 'user_profile_pic_updated',
                        userId,
                        profilePic: imageUrl
                    }));
                }
            });
        } catch (broadcastErr) {
            console.error('Failed to broadcast profile pic update:', broadcastErr);
        }

        res.json({ url: imageUrl });
    } catch (error) {
        console.error('Error uploading profile picture:', error);
        res.status(500).json({ error: 'Failed to upload profile picture' });
    }
});


app.get('/api/find-user', async (req, res) => {
    const { displayName, code } = req.query;
    if (!displayName || !code) {
        return res.status(400).json({ error: 'displayName and secret word are required' });
    }
    try {
        // Find user by secret word
        const user = await db.collection('users').findOne({ displayName: displayName, secretWord: code });
        
        if (!user) {
            return res.status(404).json({ error: 'User not found' });
        }
        res.json({
            userId: user.id,
            name: user.name,
            fullName: user.fullName,
            profilePic: user.profilePic || null
        });
    } catch (err) {
        console.error('Error finding user:', err);
        res.status(500).json({ error: 'Failed to fetch user' });
    }
});

// Debug endpoint to check user data
app.get('/debug/user/:userId', async (req, res) => {
    const { userId } = req.params;
    console.log('Debug: Checking user data for:', userId);
    try {
        const user = await db.collection('users').findOne({ id: userId });
        if (!user) {
            console.log('Debug: User not found:', userId);
            return res.status(404).json({ error: 'User not found' });
        }
        
        console.log('Debug: Full user data:', JSON.stringify(user, null, 2));
        res.json({ 
            userId: user.id, 
            name: user.name,
            formatting: user.formatting,
            fullUserData: user
        });
    } catch (error) {
        console.error('Debug: Error fetching user:', error);
        res.status(500).json({ error: 'Failed to fetch user' });
    }
});

// Giphy API proxy endpoints
app.get('/api/gifs/search', async (req, res) => {
    try {
        const { q, limit = 20 } = req.query;
        if (!q) {
            return res.status(400).json({ error: 'Query parameter required' });
        }

        const response = await fetch(`https://api.giphy.com/v1/gifs/search?api_key=GlVGYHkr3WSBnllca54iNt0yFbjz7L65&q=${encodeURIComponent(q)}&limit=${limit}&rating=g`);
        const data = await response.json();
        
        res.json(data);
    } catch (error) {
        console.error('Error searching GIFs:', error);
        res.status(500).json({ error: 'Failed to search GIFs' });
    }
});

app.get('/api/gifs/trending', async (req, res) => {
    try {
        const { limit = 20 } = req.query;
        
        const response = await fetch(`https://api.giphy.com/v1/gifs/trending?api_key=GlVGYHkr3WSBnllca54iNt0yFbjz7L65&limit=${limit}&rating=g`);
        const data = await response.json();
        
        res.json(data);
    } catch (error) {
        console.error('Error loading trending GIFs:', error);
        res.status(500).json({ error: 'Failed to load trending GIFs' });
    }
});

// Rename chat endpoint (only creator can rename)
app.post('/api/chats/:chatId/rename', async (req, res) => {
    const chatId = req.params.chatId;
    const { userId, newName } = req.body;
    if (!userId || !newName) {
        return res.status(400).json({ error: 'userId and newName are required' });
    }
    // Moderation: Check if user is banned
    if (await isUserBanned(userId)) {
        return res.status(403).json({ error: 'You are banned from renaming chats.' });
    }
    // Moderation: Check for bad words in new chat name
    if (containsBadWord(newName)) {
        await banUser(userId, 'Inappropriate chat name (rename)');
        return res.status(400).json({ error: 'Chat name contains inappropriate language. You have been banned for 24 hours.' });
    }
    try {
        const chat = await db.collection('chats').findOne({ id: chatId });
        if (!chat) {
            return res.status(404).json({ error: 'Chat not found' });
        }
        if (chat.creatorId !== userId) {
            return res.status(403).json({ error: 'Only the chat creator can rename this chat' });
        }
        await db.collection('chats').updateOne(
            { id: chatId },
            { $set: { name: newName } }
        );
        res.json({ success: true, newName });
    } catch (error) {
        console.error('Error renaming chat:', error);
        res.status(500).json({ error: 'Failed to rename chat' });
    }
});

// Bulk delete messages in a chat (only if they belong to the requesting user)
app.post('/api/chats/:chatId/delete-messages', async (req, res) => {
    const chatId = req.params.chatId;
    const { userId, messageIds } = req.body;
    if (!userId || !Array.isArray(messageIds) || messageIds.length === 0) {
        return res.status(400).json({ error: 'userId and messageIds[] are required' });
    }
    try {
        // Remove all messages with matching IDs and userId from the messages array
        const result = await db.collection('chats').updateOne(
            { id: chatId },
            { $pull: { messages: { id: { $in: messageIds }, userId } } }
        );
        res.json({ modifiedCount: result.modifiedCount });
    } catch (error) {
        console.error('Bulk delete error:', error);
        res.status(500).json({ error: 'Failed to delete messages' });
    }
});

// Edit a message in a chat (only if it belongs to the requesting user)
app.post('/api/chats/:chatId/edit-message', async (req, res) => {
    const chatId = req.params.chatId;
    const { userId, messageId, newContent } = req.body;
    if (!userId || !messageId || typeof newContent !== 'string') {
        return res.status(400).json({ error: 'userId, messageId, and newContent are required' });
    }
    try {
        // Only update the message if it belongs to the user
        const result = await db.collection('chats').updateOne(
            { id: chatId, "messages.id": messageId, "messages.userId": userId },
            { $set: { "messages.$.content": newContent } }
        );
        if (result.modifiedCount === 0) {
            return res.status(404).json({ error: 'Message not found or not authorized' });
        }
        res.json({ success: true });
    } catch (error) {
        console.error('Edit message error:', error);
        res.status(500).json({ error: 'Failed to edit message' });
    }
});

// Get all users
app.get('/api/all-users', async (req, res) => {
    try {
        const users = await db.collection('users').find({}, { projection: { id: 1, name: 1, fullName: 1 } }).toArray();
        res.json(users);
    } catch (error) {
        res.status(500).json({ error: 'Failed to fetch users' });
    }
});

// Create a new group chat
app.post('/create-group-chat', async (req, res) => {
    const { name, members, isPrivate } = req.body;
    const creatorId = members[members.length-1]; // Last user is creator

    if (!name || !members || members.length === 0) {
        return res.status(400).json({ error: 'Missing chat name or members' });
    }
    // Moderation: Check if creator is banned
    if (await isUserBanned(creatorId)) {
        return res.status(403).json({ error: 'You are banned from creating chats.' });
    }
    // Moderation: Check for bad words in chat name
    if (containsBadWord(name)) {
        await banUser(creatorId, 'Inappropriate chat name');
        return res.status(400).json({ error: 'Chat name contains inappropriate language. You have been banned for 24 hours.' });
    }

    try {
        const newChat = {
            id: uuidv4(),
            name: name,
            creatorId: creatorId,
            createdAt: Date.now(),
            messages: [],
            members: members,
            isPrivate: isPrivate || false,
        };

        await db.collection('chats').insertOne(newChat);
        
        // Add this chat to the starred list for all members
        await db.collection('users').updateMany(
            { id: { $in: members } },
            { $addToSet: { starredChats: newChat.id } }
        );

        res.status(201).json(newChat);
    } catch (error) {
        console.error('Error creating group chat:', error);
        res.status(500).json({ error: 'Failed to create group chat' });
    }
});

// --- Moderation System ---
// List of bad words (expand as needed)
const BAD_WORDS = [
    'badword1', 'badword2', 'badword3', 'fuck', 'shit', 'bitch', 'asshole', 'cunt', 'nigger', 'faggot', 'dick', 'pussy', 'cock', 'slut', 'whore', 'bastard', 'damn', 'crap', 'twat', 'wank', 'bollock', 'bugger', 'arse', 'prick', 'spastic', 'retard', 'wanker', 'motherfucker', 'douche', 'cum', 'jizz', 'tit', 'boob', 'boobs', 'penis', 'vagina', 'anus', 'fag', 'dyke', 'homo', 'queer', 'rape', 'rapist', 'molest', 'molester', 'pedo', 'paedo', 'pedophile', 'paedophile', 'nazi', 'hitler', 'heil', 'kkk', 'klan', 'coon', 'chink', 'gook', 'spic', 'wetback', 'beaner', 'kike', 'heeb', 'jap', 'gypsy', 'tranny', 'shemale', 'tits', 'balls', 'testicle', 'scrotum', 'ejaculate', 'masturbate', 'orgasm', 'clit', 'clitoris', 'dildo', 'buttplug', 'butt plug', 'butt-plug', 'fisting', 'rimjob', 'rim job', 'rim-job', 'blowjob', 'blow job', 'blow-job', 'handjob', 'hand job', 'hand-job', 'cocksucker', 'cock sucker', 'cock-sucker', 'mother fucker', 'mother-fucker', 'son of a bitch', 'son-of-a-bitch', 'ass', 'arsehole', 'shithead', 'shit head', 'shit-head', 'fuckface', 'fuck face', 'fuck-face', 'dickhead', 'dick head', 'dick-head', 'piss', 'pissed', 'pissing', 'piss off', 'piss-off', 'piss off', 'piss-off', 'bastard', 'bollocks', 'bugger', 'choad', 'crap', 'dammit', 'darn', 'frigger', 'goddamn', 'god damn', 'god-damn', 'hell', 'jerk', 'pussy', 'shit', 'shite', 'shitty', 'shitting', 'shitty', 'shat', 'shite', 'slut', 'son of a bitch', 'son-of-a-bitch', 'spunk', 'turd', 'twat', 'wank', 'wanker', 'whore'
];

function containsBadWord(text) {
    if (!text) return false;
    const lower = text.toLowerCase();
    return BAD_WORDS.some(word => lower.includes(word));
}

async function banUser(userId, reason = 'Inappropriate content') {
    const bannedUntil = Date.now() + 24 * 60 * 60 * 1000; // 24 hours
    await db.collection('users').updateOne(
        { id: userId },
        { $set: { bannedUntil, banReason: reason } }
    );
    // Disconnect all sockets for this user
    wss.clients.forEach((client) => {
        if (client.userId === userId && client.readyState === WebSocket.OPEN) {
            client.send(JSON.stringify({ type: 'banned', reason, bannedUntil }));
            client.close();
        }
    });
}

async function isUserBanned(userId) {
    const user = await db.collection('users').findOne({ id: userId });
    if (!user || !user.bannedUntil) return false;
    return user.bannedUntil > Date.now();
}

// Connect to MongoDB and start the server
const PORT = process.env.PORT || 3000;
connectDB().then(() => {
    server.listen(PORT, () => {
        console.log(`Server is running on port ${PORT}`);
    });
});
