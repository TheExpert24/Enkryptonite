const express = require('express');
const { MongoClient, ObjectId } = require('mongodb');
const multer = require('multer');
const path = require('path');
const fs = require('fs');
const { v4: uuidv4 } = require('uuid');
const natural = require('natural');
const stringSimilarity = require('string-similarity');
require('dotenv').config();

const app = express();
const PORT = process.env.PORT || 3000;

// MongoDB connection
const mongoUri = process.env.MONGODB_URI || 'mongodb://localhost:27017/chatapp';
let db;

MongoClient.connect(mongoUri)
    .then(client => {
        console.log('Connected to MongoDB');
        db = client.db();
    })
    .catch(error => console.error('MongoDB connection error:', error));

// Middleware
app.use(express.json({ limit: '10mb' }));
app.use(express.static('public'));

// Configure multer for file uploads
const storage = multer.diskStorage({
    destination: function (req, file, cb) {
        const uploadDir = 'public/uploads';
        if (!fs.existsSync(uploadDir)) {
            fs.mkdirSync(uploadDir, { recursive: true });
        }
        cb(null, uploadDir);
    },
    filename: function (req, file, cb) {
        const uniqueSuffix = Date.now() + '-' + Math.round(Math.random() * 1E9);
        cb(null, 'profile-' + uniqueSuffix + path.extname(file.originalname));
    }
});

const upload = multer({ 
    storage: storage,
    limits: { fileSize: 5 * 1024 * 1024 }, // 5MB limit
    fileFilter: (req, file, cb) => {
        if (file.mimetype.startsWith('image/')) {
            cb(null, true);
        } else {
            cb(new Error('Only image files are allowed'));
        }
    }
});

// Enhanced content filter with better logic
function isContentAppropriate(text) {
    if (!text || typeof text !== 'string') return true;
    
    const lowerText = text.toLowerCase().trim();
    
    // Skip filtering for very short messages
    if (lowerText.length <= 3) return true;
    
    // Explicit inappropriate content patterns
    const inappropriatePatterns = [
        /\b(fuck|shit|damn|bitch|asshole|bastard)\b/i,
        /\b(kill\s+yourself|kys)\b/i,
        /\b(suicide|self\s*harm)\b/i,
        /\b(nazi|hitler|holocaust\s+denial)\b/i,
        /\b(rape|sexual\s+assault)\b/i,
        /\b(child\s+porn|cp)\b/i,
        /\b(terrorist|bomb\s+threat)\b/i,
        /\b(doxx|dox)\b/i
    ];
    
    // Check for explicit patterns
    for (const pattern of inappropriatePatterns) {
        if (pattern.test(lowerText)) {
            return false;
        }
    }
    
    // Allow common greetings and normal conversation
    const allowedPhrases = [
        'hello', 'hi', 'hey', 'good morning', 'good afternoon', 'good evening',
        'how are you', 'whats up', 'thank you', 'thanks', 'please', 'sorry',
        'yes', 'no', 'ok', 'okay', 'sure', 'maybe', 'probably', 'definitely'
    ];
    
    for (const phrase of allowedPhrases) {
        if (lowerText.includes(phrase)) {
            return true;
        }
    }
    
    return true; // Default to allowing content unless explicitly inappropriate
}

// Ban management functions
async function isBanned(userId) {
    try {
        const user = await db.collection('users').findOne({ userId });
        if (!user) return false;
        
        if (user.bannedUntil && user.bannedUntil > Date.now()) {
            return true;
        }
        
        // Clean up expired bans
        if (user.bannedUntil && user.bannedUntil <= Date.now()) {
            await db.collection('users').updateOne(
                { userId },
                { $unset: { bannedUntil: "", banReason: "" } }
            );
        }
        
        return false;
    } catch (error) {
        console.error('Error checking ban status:', error);
        return false;
    }
}

async function banUser(userId, reason = 'Inappropriate content', durationHours = 24) {
    try {
        const bannedUntil = Date.now() + (durationHours * 60 * 60 * 1000);
        await db.collection('users').updateOne(
            { userId },
            { 
                $set: { 
                    bannedUntil,
                    banReason: reason,
                    lastBanDate: Date.now()
                }
            }
        );
        console.log(`User ${userId} banned until ${new Date(bannedUntil)}`);
        return true;
    } catch (error) {
        console.error('Error banning user:', error);
        return false;
    }
}

// Secure user registration endpoint
app.post('/register-user', upload.single('profilePic'), async (req, res) => {
    try {
        const { displayName, userId: existingUserId } = req.body;
        
        if (!displayName || displayName.trim().length < 2) {
            return res.status(400).json({ error: 'Display name must be at least 2 characters' });
        }
        
        if (displayName.length > 32) {
            return res.status(400).json({ error: 'Display name must be 32 characters or less' });
        }
        
        // Check for reserved names
        const reservedNames = ['admin', 'moderator', 'support', 'administrator', 'mod', 'help', 'system'];
        if (reservedNames.includes(displayName.toLowerCase())) {
            return res.status(400).json({ error: 'This display name is reserved' });
        }
        
        let userId = existingUserId || uuidv4();
        
        // Check if user is banned
        if (await isBanned(userId)) {
            return res.status(403).json({ error: 'User is banned' });
        }
        
        // Generate secure secret word (not exposed to client)
        const secretWord = Math.random().toString(36).substring(2, 15) + Math.random().toString(36).substring(2, 15);
        
        let profilePicUrl = null;
        if (req.file) {
            profilePicUrl = `/uploads/${req.file.filename}`;
        }
        
        const userData = {
            userId,
            displayName: displayName.trim(),
            secretWord, // Store securely, never expose
            profilePic: profilePicUrl,
            createdAt: Date.now(),
            lastActive: Date.now(),
            starredChats: []
        };
        
        // Upsert user data
        await db.collection('users').updateOne(
            { userId },
            { $set: userData },
            { upsert: true }
        );
        
        // Return safe user data (no secret word)
        res.json({
            userId: userData.userId,
            displayName: userData.displayName,
            profilePic: userData.profilePic
        });
        
    } catch (error) {
        console.error('Error registering user:', error);
        res.status(500).json({ error: 'Internal server error' });
    }
});

// Secure user lookup endpoint (for sign-in only)
app.get('/api/find-user', async (req, res) => {
    try {
        const { displayName, code } = req.query;
        
        if (!displayName || !code) {
            return res.status(400).json({ error: 'Missing parameters' });
        }
        
        const user = await db.collection('users').findOne({
            displayName: displayName.trim(),
            secretWord: code.trim()
        });
        
        if (!user) {
            return res.status(404).json({ error: 'User not found' });
        }
        
        // Check if banned
        if (await isBanned(user.userId)) {
            return res.status(403).json({ error: 'User is banned' });
        }
        
        // Return minimal data for sign-in
        res.json({
            userId: user.userId,
            name: user.displayName
        });
        
    } catch (error) {
        console.error('Error finding user:', error);
        res.status(500).json({ error: 'Internal server error' });
    }
});

// SECURE: Get user profile (no sensitive data)
app.get('/user/:userId', async (req, res) => {
    try {
        const { userId } = req.params;
        
        const user = await db.collection('users').findOne({ userId });
        if (!user) {
            return res.status(404).json({ error: 'User not found' });
        }
        
        // Return only safe, public user data
        const safeUserData = {
            userId: user.userId,
            displayName: user.displayName,
            profilePic: user.profilePic,
            createdAt: user.createdAt,
            lastActive: user.lastActive,
            // Only include ban status if user is currently banned
            ...(user.bannedUntil && user.bannedUntil > Date.now() ? { bannedUntil: user.bannedUntil } : {})
        };
        
        res.json(safeUserData);
        
    } catch (error) {
        console.error('Error fetching user:', error);
        res.status(500).json({ error: 'Internal server error' });
    }
});

// Profile picture upload endpoint
app.post('/upload-profile-pic', upload.single('profilePic'), (req, res) => {
    try {
        if (!req.file) {
            return res.status(400).json({ error: 'No file uploaded' });
        }
        
        res.json({ url: `/uploads/${req.file.filename}` });
    } catch (error) {
        console.error('Error uploading profile picture:', error);
        res.status(500).json({ error: 'Upload failed' });
    }
});

// Create chat endpoint with proper authorization
app.post('/create-chat', async (req, res) => {
    try {
        const { name, isPrivate = false, members = [] } = req.body;
        const creatorId = req.headers['x-user-id'] || req.body.creatorId;
        
        if (!name || !creatorId) {
            return res.status(400).json({ error: 'Missing required fields' });
        }
        
        if (await isBanned(creatorId)) {
            return res.status(403).json({ error: 'User is banned' });
        }
        
        const chatId = uuidv4();
        const chatData = {
            id: chatId,
            name: name.trim(),
            creatorId,
            isPrivate,
            members: isPrivate ? members : [],
            messages: [],
            createdAt: Date.now()
        };
        
        await db.collection('chats').insertOne(chatData);
        res.json(chatData);
        
    } catch (error) {
        console.error('Error creating chat:', error);
        res.status(500).json({ error: 'Failed to create chat' });
    }
});

// SECURE: Get chat with proper authorization
app.get('/chat/:chatId', async (req, res) => {
    try {
        const { chatId } = req.params;
        const userId = req.headers['x-user-id'] || req.query.userId;
        
        const chat = await db.collection('chats').findOne({ id: chatId });
        if (!chat) {
            return res.status(404).json({ error: 'Chat not found' });
        }
        
        // Check authorization for private chats
        if (chat.isPrivate) {
            if (!userId) {
                return res.status(401).json({ error: 'Authentication required' });
            }
            
            // Only allow access if user is a member or creator
            if (chat.creatorId !== userId && !chat.members.includes(userId)) {
                return res.status(403).json({ error: 'Access denied' });
            }
        }
        
        res.json(chat);
        
    } catch (error) {
        console.error('Error fetching chat:', error);
        res.status(500).json({ error: 'Failed to fetch chat' });
    }
});

// SECURE: Send message with proper validation
app.post('/send-message', async (req, res) => {
    try {
        const { chatId, message, userId, userName, isEncrypted = false, encryptedData = null } = req.body;
        
        if (!chatId || !userId || !userName) {
            return res.status(400).json({ error: 'Missing required fields' });
        }
        
        if (await isBanned(userId)) {
            return res.status(403).json({ error: 'User is banned' });
        }
        
        // Get chat to check authorization
        const chat = await db.collection('chats').findOne({ id: chatId });
        if (!chat) {
            return res.status(404).json({ error: 'Chat not found' });
        }
        
        // Check authorization for private chats
        if (chat.isPrivate) {
            if (chat.creatorId !== userId && !chat.members.includes(userId)) {
                return res.status(403).json({ error: 'Access denied' });
            }
        }
        
        let messageContent = message;
        let messageData = {
            id: uuidv4(),
            userId,
            userName,
            timestamp: Date.now(),
            isEncrypted
        };
        
        if (isEncrypted && encryptedData) {
            // Store encrypted message data
            messageData.encryptedData = encryptedData;
            messageData.message = '[Encrypted Message]'; // Placeholder for display
        } else {
            // Validate plain text message
            if (!message || message.trim().length === 0) {
                return res.status(400).json({ error: 'Message cannot be empty' });
            }
            
            if (!isContentAppropriate(message)) {
                await banUser(userId, 'Inappropriate content');
                return res.status(403).json({ error: 'Message contains inappropriate content. User has been banned.' });
            }
            
            messageData.message = message.trim();
        }
        
        // Add message to chat
        await db.collection('chats').updateOne(
            { id: chatId },
            { 
                $push: { messages: messageData },
                $set: { lastActivity: Date.now() }
            }
        );
        
        // Update user's last active time
        await db.collection('users').updateOne(
            { userId },
            { $set: { lastActive: Date.now() } }
        );
        
        res.json({ success: true, messageId: messageData.id });
        
    } catch (error) {
        console.error('Error sending message:', error);
        res.status(500).json({ error: 'Failed to send message' });
    }
});

// Get all chats (public only, unless user is authenticated)
app.get('/api/all-chats', async (req, res) => {
    try {
        const page = parseInt(req.query.page) || 1;
        const limit = parseInt(req.query.limit) || 10;
        const userId = req.headers['x-user-id'] || req.query.userId;
        
        const skip = (page - 1) * limit;
        
        // Build query - only show public chats or private chats user has access to
        let query = { isPrivate: { $ne: true } };
        
        if (userId) {
            // If user is authenticated, also show their private chats
            query = {
                $or: [
                    { isPrivate: { $ne: true } },
                    { creatorId: userId },
                    { members: userId }
                ]
            };
        }
        
        const chats = await db.collection('chats')
            .find(query)
            .sort({ createdAt: -1 })
            .skip(skip)
            .limit(limit + 1)
            .toArray();
        
        const hasMore = chats.length > limit;
        if (hasMore) chats.pop();
        
        res.json({ chats, hasMore });
        
    } catch (error) {
        console.error('Error fetching chats:', error);
        res.status(500).json({ error: 'Failed to fetch chats' });
    }
});

// Search chats (public only)
app.get('/api/search-chats', async (req, res) => {
    try {
        const { q } = req.query;
        if (!q) {
            return res.status(400).json({ error: 'Search query required' });
        }
        
        const chats = await db.collection('chats')
            .find({ 
                name: { $regex: q, $options: 'i' },
                isPrivate: { $ne: true } // Only search public chats
            })
            .sort({ createdAt: -1 })
            .limit(50)
            .toArray();
        
        res.json(chats);
        
    } catch (error) {
        console.error('Error searching chats:', error);
        res.status(500).json({ error: 'Search failed' });
    }
});

// SECURE: Find or create private chat
app.get('/api/private-chat', async (req, res) => {
    try {
        const { user1, user2 } = req.query;
        
        if (!user1 || !user2) {
            return res.status(400).json({ error: 'Both user IDs required' });
        }
        
        // Check if either user is banned
        if (await isBanned(user1) || await isBanned(user2)) {
            return res.status(403).json({ error: 'One or more users are banned' });
        }
        
        // Look for existing private chat between these users
        const existingChat = await db.collection('chats').findOne({
            isPrivate: true,
            $or: [
                { creatorId: user1, members: user2 },
                { creatorId: user2, members: user1 }
            ]
        });
        
        if (existingChat) {
            res.json({ chatId: existingChat.id });
        } else {
            res.status(404).json({ error: 'Private chat not found' });
        }
        
    } catch (error) {
        console.error('Error finding private chat:', error);
        res.status(500).json({ error: 'Failed to find private chat' });
    }
});

// Delete chat (only by creator)
app.delete('/api/chats/:chatId', async (req, res) => {
    try {
        const { chatId } = req.params;
        const userId = req.query.userId;
        
        if (!userId) {
            return res.status(401).json({ error: 'Authentication required' });
        }
        
        const chat = await db.collection('chats').findOne({ id: chatId });
        if (!chat) {
            return res.status(404).json({ error: 'Chat not found' });
        }
        
        if (chat.creatorId !== userId) {
            return res.status(403).json({ error: 'Only the creator can delete this chat' });
        }
        
        await db.collection('chats').deleteOne({ id: chatId });
        res.json({ success: true });
        
    } catch (error) {
        console.error('Error deleting chat:', error);
        res.status(500).json({ error: 'Failed to delete chat' });
    }
});

// Star/unstar chat endpoints
app.post('/api/user/:userId/star', async (req, res) => {
    try {
        const { userId } = req.params;
        const { chatId } = req.body;
        
        if (!chatId) {
            return res.status(400).json({ error: 'Chat ID required' });
        }
        
        await db.collection('users').updateOne(
            { userId },
            { $addToSet: { starredChats: chatId } },
            { upsert: true }
        );
        
        res.json({ success: true });
        
    } catch (error) {
        console.error('Error starring chat:', error);
        res.status(500).json({ error: 'Failed to star chat' });
    }
});

app.post('/api/user/:userId/unstar', async (req, res) => {
    try {
        const { userId } = req.params;
        const { chatId } = req.body;
        
        if (!chatId) {
            return res.status(400).json({ error: 'Chat ID required' });
        }
        
        await db.collection('users').updateOne(
            { userId },
            { $pull: { starredChats: chatId } }
        );
        
        res.json({ success: true });
        
    } catch (error) {
        console.error('Error unstarring chat:', error);
        res.status(500).json({ error: 'Failed to unstar chat' });
    }
});

app.get('/api/user/:userId/starred-chats', async (req, res) => {
    try {
        const { userId } = req.params;
        
        const user = await db.collection('users').findOne({ userId });
        if (!user) {
            return res.status(404).json({ error: 'User not found' });
        }
        
        const starredChatIds = user.starredChats || [];
        const starredChats = await db.collection('chats')
            .find({ id: { $in: starredChatIds } })
            .toArray();
        
        res.json(starredChats);
        
    } catch (error) {
        console.error('Error fetching starred chats:', error);
        res.status(500).json({ error: 'Failed to fetch starred chats' });
    }
});

// Serve static files
app.get('/', (req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

app.get('/welcome', (req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'welcome.html'));
});

// Start server
app.listen(PORT, () => {
    console.log(`Server running on port ${PORT}`);
});