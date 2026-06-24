require('dotenv').config();

const express = require('express');
const multer = require('multer');
const path = require('path');
const crypto = require('crypto');
const session = require('express-session');
const bcrypt = require('bcryptjs');
const { BlobServiceClient } = require('@azure/storage-blob');
const sql = require('mssql');

const app = express();

app.use(express.json());
app.use(express.urlencoded({ extended: true }));
const sqlConnectionString = process.env.AZURE_SQL_CONNECTION_STRING;
let sqlPool = null;
const sqlConfig = sqlConnectionString ? parseSqlConnectionString(sqlConnectionString) : null;

// Session middleware: use SQL-backed store when available, otherwise memory store
const sessionOptions = {
    name: 'pixora.sid',
    secret: process.env.SESSION_SECRET || 'pixora-dev-secret-change-in-production',
    resave: false,
    saveUninitialized: false,
    rolling: true,
    cookie: {
        maxAge: 7 * 24 * 60 * 60 * 1000,
        httpOnly: true,
        secure: process.env.NODE_ENV === 'production',
        sameSite: 'lax'
    }
};

if (sqlConfig) {
    try {
        const MSSQLStore = require('connect-mssql-v2');
        sessionOptions.store = new MSSQLStore(sqlConfig, {
            table: '[sessions]',
            ttl: 7 * 24 * 60 * 60 * 1000,
            autoRemove: true,
            autoRemoveInterval: 1000 * 60 * 60
        });
        console.log('Using SQL session store');
    } catch (err) {
        console.error('SQL session store failed:', err.message);
    }
}

app.use(session(sessionOptions));
app.use(express.static(path.join(__dirname, 'public')));

const upload = multer({ storage: multer.memoryStorage() });

// ---------- Azure Blob Storage ----------
// Images are stored in the 'images' container. User avatars are stored in the 'avatars' container.
// Future-ready: Azure CDN can front these containers; Azure Key Vault can store the connection string;
// Azure Functions can handle async tasks such as thumbnail generation or moderation.
const connectionString = process.env.AZURE_STORAGE_CONNECTION_STRING;
console.log(connectionString ? 'Storage connection string loaded' : 'Storage connection string missing');

const blobServiceClient = BlobServiceClient.fromConnectionString(connectionString);
const imagesContainer = blobServiceClient.getContainerClient('images');
const avatarsContainer = blobServiceClient.getContainerClient('avatars');

async function initContainers() {
    if (!connectionString) return;
    try {
        await imagesContainer.createIfNotExists();
        await avatarsContainer.createIfNotExists();
        console.log('Blob containers ready');
    } catch (err) {
        console.error('Blob container init failed:', err.message);
    }
}

// ---------- Azure SQL Database ----------

function parseSqlConnectionString(cs) {
    const parts = cs.split(';').filter(Boolean);
    const map = {};

    for (const part of parts) {
        const idx = part.indexOf('=');
        if (idx === -1) continue;
        const key = part.substring(0, idx).trim();
        let value = part.substring(idx + 1).trim();
        if (value.startsWith('{') && value.endsWith('}')) {
            value = value.slice(1, -1);
        }
        map[key.toLowerCase()] = value;
    }

    const rawServer = map['server'] || map['data source'] || '';
    const server = rawServer.replace(/^tcp:/i, '').replace(/,1433$/, '').trim();
    const portMatch = rawServer.match(/,(\d+)$/);

    return {
        server,
        port: portMatch ? parseInt(portMatch[1], 10) : 1433,
        user: map['user id'] || map['uid'],
        password: map['password'] || map['pwd'],
        database: map['initial catalog'] || map['database'],
        options: {
            encrypt: map['encrypt']?.toLowerCase() === 'true',
            trustServerCertificate: map['trustservercertificate']?.toLowerCase() === 'true',
            connectTimeout: parseInt(map['connection timeout'] || '30', 10) * 1000
        }
    };
}

async function initSql() {
    if (!sqlConnectionString) {
        console.log('SQL connection string missing — running without database');
        return;
    }

    try {
        const config = parseSqlConnectionString(sqlConnectionString);
        sqlPool = await sql.connect(config);
        console.log('Connected to Azure SQL Database');

        await sqlPool.request().query(`
            IF NOT EXISTS (SELECT * FROM sysobjects WHERE name='Users' AND xtype='U')
            CREATE TABLE Users (
                Id INT IDENTITY(1,1) PRIMARY KEY,
                Username NVARCHAR(100) NOT NULL,
                Email NVARCHAR(255) NOT NULL,
                PasswordHash NVARCHAR(255) NOT NULL,
                Bio NVARCHAR(500) NULL,
                ProfilePicture NVARCHAR(255) NULL,
                JoinDate DATETIME2 NOT NULL DEFAULT GETUTCDATE(),
                IsActive BIT NOT NULL DEFAULT 1,
                CONSTRAINT UQ_Users_Username UNIQUE (Username),
                CONSTRAINT UQ_Users_Email UNIQUE (Email)
            )
        `);

        await sqlPool.request().query(`
            IF NOT EXISTS (SELECT * FROM sysobjects WHERE name='Images' AND xtype='U')
            CREATE TABLE Images (
                Id INT IDENTITY(1,1) PRIMARY KEY,
                FileName NVARCHAR(255) NOT NULL,
                BlobName NVARCHAR(255) NOT NULL,
                UploadTime DATETIME2 NOT NULL DEFAULT GETUTCDATE(),
                FileSize BIGINT NOT NULL,
                Uploader NVARCHAR(100) NOT NULL,
                Tags NVARCHAR(500) NULL,
                Caption NVARCHAR(1000) NULL
            )
        `);

        await sqlPool.request().query(`
            IF NOT EXISTS (SELECT * FROM sysobjects WHERE name='Likes' AND xtype='U')
            CREATE TABLE Likes (
                Id INT IDENTITY(1,1) PRIMARY KEY,
                ImageId INT NOT NULL,
                Uploader NVARCHAR(100) NOT NULL,
                CreatedAt DATETIME2 NOT NULL DEFAULT GETUTCDATE(),
                CONSTRAINT UQ_Likes_Image_User UNIQUE (ImageId, Uploader)
            )
        `);

        await sqlPool.request().query(`
            IF NOT EXISTS (SELECT * FROM sysobjects WHERE name='Comments' AND xtype='U')
            CREATE TABLE Comments (
                Id INT IDENTITY(1,1) PRIMARY KEY,
                ImageId INT NOT NULL,
                Uploader NVARCHAR(100) NOT NULL,
                CommentText NVARCHAR(1000) NOT NULL,
                CreatedAt DATETIME2 NOT NULL DEFAULT GETUTCDATE()
            )
        `);

        await sqlPool.request().query(`
            IF NOT EXISTS (SELECT * FROM sysobjects WHERE name='sessions' AND xtype='U')
            CREATE TABLE sessions (
                sid NVARCHAR(255) NOT NULL PRIMARY KEY,
                session NVARCHAR(MAX) NOT NULL,
                expires DATETIME NOT NULL
            )
        `);

        const migrations = [
            `ALTER TABLE Images ADD Tags NVARCHAR(500) NULL`,
            `ALTER TABLE Images ADD Caption NVARCHAR(1000) NULL`
        ];

        for (const migration of migrations) {
            try {
                await sqlPool.request().query(migration);
            } catch (_) {
                // Column already exists
            }
        }

        console.log('Database tables ready');
    } catch (err) {
        console.error('SQL init failed:', err.message);
        sqlPool = null;
    }
}

// ---------- Azure AI Vision ----------

const visionEndpoint = process.env.AZURE_VISION_ENDPOINT;
const visionKey = process.env.AZURE_VISION_KEY;
const visionEnabled = !!(visionEndpoint && visionKey);

async function analyzeImage(buffer) {
    if (!visionEnabled) return [];

    try {
        const url = visionEndpoint.replace(/\/+$/, '') + '/vision/v3.2/analyze?visualFeatures=Tags';
        const response = await fetch(url, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/octet-stream',
                'Ocp-Apim-Subscription-Key': visionKey
            },
            body: buffer
        });

        if (!response.ok) {
            console.error('Vision API error:', response.status, response.statusText);
            return [];
        }

        const data = await response.json();
        if (!data.tags) return [];

        return data.tags
            .filter(t => t.confidence >= 0.5)
            .slice(0, 8)
            .map(t => t.name);
    } catch (err) {
        console.error('Vision API failed:', err.message);
        return [];
    }
}

// ---------- Helpers ----------

function sanitizeUsername(input) {
    return (input || '').trim().toLowerCase().replace(/[^a-z0-9_]/g, '').slice(0, 30);
}

function sanitizeEmail(input) {
    return (input || '').trim().toLowerCase().slice(0, 255);
}

function validatePassword(input) {
    return typeof input === 'string' && input.length >= 6 && input.length <= 128;
}

function formatFileSize(bytes) {
    if (!bytes && bytes !== 0) return '';
    if (bytes === 0) return '0 B';
    const units = ['B', 'KB', 'MB', 'GB'];
    const i = Math.min(Math.floor(Math.log(bytes) / Math.log(1024)), units.length - 1);
    const val = bytes / Math.pow(1024, i);
    return val.toFixed(i > 0 ? 1 : 0) + ' ' + units[i];
}

function formatDate(dateStr) {
    if (!dateStr) return '';
    const d = new Date(dateStr);
    return d.toLocaleDateString('en-US', { year: 'numeric', month: 'short', day: 'numeric' });
}

function timeAgo(dateStr) {
    if (!dateStr) return '';
    const date = new Date(dateStr);
    const now = new Date();
    const seconds = Math.floor((now - date) / 1000);

    const intervals = [
        { label: 'year', seconds: 31536000 },
        { label: 'month', seconds: 2592000 },
        { label: 'week', seconds: 604800 },
        { label: 'day', seconds: 86400 },
        { label: 'hour', seconds: 3600 },
        { label: 'minute', seconds: 60 }
    ];

    for (const interval of intervals) {
        const count = Math.floor(seconds / interval.seconds);
        if (count >= 1) {
            return `${count} ${interval.label}${count > 1 ? 's' : ''} ago`;
        }
    }
    return 'Just now';
}

function ensureSql() {
    if (!sqlPool) {
        throw new Error('SQL not connected');
    }
}

function uniqueBlobName(originalName) {
    const ext = path.extname(originalName) || '';
    const base = path.basename(originalName, ext).replace(/[^a-zA-Z0-9_-]/g, '_');
    return `${crypto.randomUUID()}_${base}${ext}`;
}

function safeBlobNameFromUsername(username, ext) {
    return `${username.replace(/[^a-zA-Z0-9_-]/g, '_')}_${Date.now()}${ext}`;
}

async function getUserByUsername(username) {
    if (!sqlPool || !username) return null;
    const result = await sqlPool.request()
        .input('Username', sql.NVarChar(100), username)
        .query('SELECT Id, Username, Email, Bio, ProfilePicture, JoinDate FROM Users WHERE Username = @Username AND IsActive = 1');
    return result.recordset[0] || null;
}

async function buildImageList(currentUser = '') {
    const blobNames = [];
    for await (const blob of imagesContainer.listBlobsFlat()) {
        blobNames.push(blob.name);
    }

    let images = [];

    if (sqlPool && blobNames.length > 0) {
        const result = await sqlPool.request()
            .input('CurrentUser', sql.NVarChar(100), currentUser || '')
            .query(`
            SELECT i.Id, i.FileName, i.BlobName, i.UploadTime, i.FileSize, i.Uploader, i.Tags, i.Caption,
                u.ProfilePicture AS Avatar,
                u.Bio AS UserBio,
                (SELECT COUNT(*) FROM Likes WHERE ImageId = i.Id) AS LikeCount,
                (SELECT COUNT(*) FROM Comments WHERE ImageId = i.Id) AS CommentCount,
                (SELECT CASE WHEN COUNT(*) > 0 THEN 1 ELSE 0 END FROM Likes WHERE ImageId = i.Id AND Uploader = @CurrentUser) AS IsLiked
            FROM Images i
            LEFT JOIN Users u ON i.Uploader = u.Username
        `);

        const sqlByBlob = {};
        for (const row of result.recordset) {
            sqlByBlob[row.BlobName] = row;
        }

        for (const name of blobNames) {
            const row = sqlByBlob[name];
            images.push(row ? {
                id: row.Id,
                fileName: row.FileName,
                blobName: row.BlobName,
                uploadTime: row.UploadTime,
                fileSize: row.FileSize,
                uploader: row.Uploader,
                avatar: row.Avatar || null,
                bio: row.UserBio || '',
                tags: row.Tags ? row.Tags.split(',').filter(Boolean) : [],
                caption: row.Caption || '',
                likeCount: row.LikeCount || 0,
                commentCount: row.CommentCount || 0,
                isLiked: row.IsLiked === 1
            } : {
                id: null,
                fileName: name,
                blobName: name,
                uploadTime: null,
                fileSize: null,
                uploader: null,
                avatar: null,
                bio: '',
                tags: [],
                caption: '',
                likeCount: 0,
                commentCount: 0,
                isLiked: false
            });
        }
    } else {
        images = blobNames.map(n => ({
            id: null,
            fileName: n,
            blobName: n,
            uploadTime: null,
            fileSize: null,
            uploader: null,
            avatar: null,
            bio: '',
            tags: [],
            caption: '',
            likeCount: 0,
            commentCount: 0,
            isLiked: false
        }));
    }

    images.sort((a, b) => {
        if (a.uploadTime && b.uploadTime) {
            return new Date(b.uploadTime) - new Date(a.uploadTime);
        }
        if (a.uploadTime) return -1;
        if (b.uploadTime) return 1;
        return a.blobName.localeCompare(b.blobName);
    });

    return images;
}

// ---------- Authentication Middleware ----------

function requireAuth(req, res, next) {
    if (!req.session || !req.session.username) {
        return res.status(401).json({ success: false, message: 'Authentication required' });
    }
    next();
}

function optionalAuth(req, res, next) {
    if (req.session && req.session.username) {
        req.currentUser = req.session.username;
    } else {
        req.currentUser = '';
    }
    next();
}

// ---------- Startup ----------

async function startup() {
    await initContainers();
    await initSql();
    console.log('Pixora startup complete');
    const PORT = process.env.PORT || 3000;
    app.listen(PORT, () => {
        console.log(`Pixora server running on port ${PORT}`);
    });
}

// ---------- API Routes ----------

// Auth
app.post('/api/auth/signup', async (req, res) => {
    try {
        ensureSql();

        const username = sanitizeUsername(req.body.username);
        const email = sanitizeEmail(req.body.email);
        const password = req.body.password;
        const bio = (req.body.bio || '').trim().slice(0, 500);

        if (!username || username.length < 3) {
            return res.status(400).json({ success: false, message: 'Username must be at least 3 characters and contain only letters, numbers, and underscores' });
        }
        if (!email || !email.includes('@')) {
            return res.status(400).json({ success: false, message: 'Valid email is required' });
        }
        if (!validatePassword(password)) {
            return res.status(400).json({ success: false, message: 'Password must be at least 6 characters' });
        }

        const existing = await sqlPool.request()
            .input('Username', sql.NVarChar(100), username)
            .input('Email', sql.NVarChar(255), email)
            .query('SELECT Id FROM Users WHERE Username = @Username OR Email = @Email');

        if (existing.recordset.length > 0) {
            return res.status(409).json({ success: false, message: 'Username or email already exists' });
        }

        const hash = await bcrypt.hash(password, 12);

        await sqlPool.request()
            .input('Username', sql.NVarChar(100), username)
            .input('Email', sql.NVarChar(255), email)
            .input('PasswordHash', sql.NVarChar(255), hash)
            .input('Bio', sql.NVarChar(500), bio || null)
            .query(`
                INSERT INTO Users (Username, Email, PasswordHash, Bio)
                VALUES (@Username, @Email, @PasswordHash, @Bio)
            `);

        req.session.username = username;
        req.session.email = email;

        res.json({ success: true, user: { username, email, bio } });
    } catch (error) {
        console.error(error);
        res.status(500).json({ success: false, message: error.message });
    }
});

app.post('/api/auth/signin', async (req, res) => {
    try {
        ensureSql();

        const username = sanitizeUsername(req.body.username);
        const email = sanitizeEmail(req.body.username);
        const password = req.body.password;

        if ((!username && !email) || !password) {
            return res.status(400).json({ success: false, message: 'Username and password are required' });
        }

        const result = await sqlPool.request()
            .input('Username', sql.NVarChar(100), username)
            .input('Email', sql.NVarChar(255), email)
            .query('SELECT Id, Username, Email, PasswordHash, Bio, ProfilePicture FROM Users WHERE (Username = @Username OR Email = @Email) AND IsActive = 1');

        const user = result.recordset[0];
        if (!user) {
            return res.status(401).json({ success: false, message: 'Invalid credentials' });
        }

        const valid = await bcrypt.compare(password, user.PasswordHash);
        if (!valid) {
            return res.status(401).json({ success: false, message: 'Invalid credentials' });
        }

        req.session.username = user.Username;
        req.session.email = user.Email;

        res.json({
            success: true,
            user: {
                username: user.Username,
                email: user.Email,
                bio: user.Bio || '',
                avatar: user.ProfilePicture || null
            }
        });
    } catch (error) {
        console.error(error);
        res.status(500).json({ success: false, message: error.message });
    }
});

app.post('/api/auth/signout', (req, res) => {
    req.session.destroy((err) => {
        if (err) {
            return res.status(500).json({ success: false, message: err.message });
        }
        res.clearCookie('pixora.sid');
        res.json({ success: true, message: 'Signed out' });
    });
});

app.get('/api/auth/me', optionalAuth, async (req, res) => {
    try {
        if (!req.currentUser) {
            return res.json({ success: true, user: null });
        }
        const user = await getUserByUsername(req.currentUser);
        if (!user) {
            req.session.destroy();
            return res.json({ success: true, user: null });
        }
        res.json({
            success: true,
            user: {
                username: user.Username,
                email: user.Email,
                bio: user.Bio || '',
                avatar: user.ProfilePicture || null
            }
        });
    } catch (error) {
        console.error(error);
        res.status(500).json({ success: false, message: error.message });
    }
});

// Update profile
app.post('/api/profile', requireAuth, async (req, res) => {
    try {
        ensureSql();

        const bio = (req.body.bio || '').trim().slice(0, 500);
        await sqlPool.request()
            .input('Username', sql.NVarChar(100), req.session.username)
            .input('Bio', sql.NVarChar(500), bio || null)
            .query('UPDATE Users SET Bio = @Bio WHERE Username = @Username');

        res.json({ success: true, bio });
    } catch (error) {
        console.error(error);
        res.status(500).json({ success: false, message: error.message });
    }
});

// Change password
app.post('/api/account/password', requireAuth, async (req, res) => {
    try {
        ensureSql();

        const currentPassword = req.body.currentPassword;
        const newPassword = req.body.newPassword;

        if (!validatePassword(newPassword)) {
            return res.status(400).json({ success: false, message: 'New password must be at least 6 characters' });
        }

        const result = await sqlPool.request()
            .input('Username', sql.NVarChar(100), req.session.username)
            .query('SELECT PasswordHash FROM Users WHERE Username = @Username AND IsActive = 1');

        const user = result.recordset[0];
        if (!user) {
            return res.status(404).json({ success: false, message: 'User not found' });
        }

        const valid = await bcrypt.compare(currentPassword, user.PasswordHash);
        if (!valid) {
            return res.status(401).json({ success: false, message: 'Current password is incorrect' });
        }

        const hash = await bcrypt.hash(newPassword, 12);
        await sqlPool.request()
            .input('Username', sql.NVarChar(100), req.session.username)
            .input('PasswordHash', sql.NVarChar(255), hash)
            .query('UPDATE Users SET PasswordHash = @PasswordHash WHERE Username = @Username');

        res.json({ success: true, message: 'Password updated' });
    } catch (error) {
        console.error(error);
        res.status(500).json({ success: false, message: error.message });
    }
});

// Delete account
app.delete('/api/account', requireAuth, async (req, res) => {
    try {
        ensureSql();
        const username = req.session.username;

        const imagesResult = await sqlPool.request()
            .input('Uploader', sql.NVarChar(100), username)
            .query('SELECT BlobName FROM Images WHERE Uploader = @Uploader');

        const userResult = await sqlPool.request()
            .input('Username', sql.NVarChar(100), username)
            .query('SELECT ProfilePicture FROM Users WHERE Username = @Username');

        for (const image of imagesResult.recordset) {
            try {
                const blockBlobClient = imagesContainer.getBlockBlobClient(image.BlobName);
                await blockBlobClient.deleteIfExists();
            } catch (err) {
                console.error('Failed to delete blob:', image.BlobName, err.message);
            }
        }

        const avatar = userResult.recordset[0]?.ProfilePicture;
        if (avatar) {
            try {
                const avatarBlobClient = avatarsContainer.getBlockBlobClient(avatar);
                await avatarBlobClient.deleteIfExists();
            } catch (err) {
                console.error('Failed to delete avatar:', avatar, err.message);
            }
        }

        await sqlPool.request()
            .input('Username', sql.NVarChar(100), username)
            .query('DELETE FROM Comments WHERE Uploader = @Username');

        await sqlPool.request()
            .input('Username', sql.NVarChar(100), username)
            .query('DELETE FROM Likes WHERE Uploader = @Username');

        await sqlPool.request()
            .input('Username', sql.NVarChar(100), username)
            .query('DELETE FROM Images WHERE Uploader = @Username');

        await sqlPool.request()
            .input('Username', sql.NVarChar(100), username)
            .query('DELETE FROM Users WHERE Username = @Username');

        req.session.destroy((err) => {
            if (err) console.error('Session destroy failed:', err.message);
        });

        res.json({ success: true, message: 'Account deleted' });
    } catch (error) {
        console.error(error);
        res.status(500).json({ success: false, message: error.message });
    }
});

// Upload avatar
app.post('/api/avatar', requireAuth, upload.single('avatar'), async (req, res) => {
    try {
        ensureSql();

        if (!req.file) {
            return res.status(400).json({ success: false, message: 'No image selected' });
        }

        await avatarsContainer.createIfNotExists();

        const ext = path.extname(req.file.originalname) || '.jpg';
        const blobName = safeBlobNameFromUsername(req.session.username, ext);
        const blockBlobClient = avatarsContainer.getBlockBlobClient(blobName);

        await blockBlobClient.uploadData(req.file.buffer, {
            blobHTTPHeaders: { blobContentType: req.file.mimetype }
        });

        await sqlPool.request()
            .input('Username', sql.NVarChar(100), req.session.username)
            .input('ProfilePicture', sql.NVarChar(255), blobName)
            .query('UPDATE Users SET ProfilePicture = @ProfilePicture WHERE Username = @Username');

        res.json({ success: true, avatar: blobName });
    } catch (error) {
        console.error('Avatar upload failed:', error);
        res.status(500).json({ success: false, message: error.message });
    }
});

// List images
app.get('/api/images', optionalAuth, async (req, res) => {
    try {
        const images = await buildImageList(req.currentUser);
        res.json({ success: true, images });
    } catch (error) {
        console.error(error);
        res.status(500).json({ success: false, message: error.message });
    }
});

// Upload images
app.post('/upload', requireAuth, upload.array('images'), async (req, res) => {
    try {
        if (!req.files || req.files.length === 0) {
            return res.status(400).json({ success: false, message: 'No files selected' });
        }

        const uploader = req.session.username;
        const caption = (req.body.caption || '').trim().slice(0, 1000);
        const results = [];

        for (const file of req.files) {
            try {
                const blobName = uniqueBlobName(file.originalname);
                const blockBlobClient = imagesContainer.getBlockBlobClient(blobName);

                await blockBlobClient.uploadData(file.buffer, {
                    blobHTTPHeaders: { blobContentType: file.mimetype }
                });

                console.log(`${blobName} uploaded successfully`);

                const tags = await analyzeImage(file.buffer);
                const tagsStr = tags.length > 0 ? tags.join(',') : null;

                if (tags.length > 0) {
                    console.log(`${blobName} tags:`, tags.join(', '));
                }

                if (sqlPool) {
                    try {
                        await sqlPool.request()
                            .input('FileName', sql.NVarChar(255), file.originalname)
                            .input('BlobName', sql.NVarChar(255), blobName)
                            .input('FileSize', sql.BigInt, file.size)
                            .input('Uploader', sql.NVarChar(100), uploader)
                            .input('Tags', sql.NVarChar(500), tagsStr)
                            .input('Caption', sql.NVarChar(1000), caption || null)
                            .query(`
                                INSERT INTO Images (FileName, BlobName, UploadTime, FileSize, Uploader, Tags, Caption)
                                VALUES (@FileName, @BlobName, GETUTCDATE(), @FileSize, @Uploader, @Tags, @Caption)
                            `);
                    } catch (sqlErr) {
                        console.error('SQL insert failed:', sqlErr.message);
                    }
                }

                results.push({ name: blobName, originalName: file.originalname, success: true });
            } catch (err) {
                results.push({ name: file.originalname, success: false, error: err.message });
            }
        }

        res.json({ success: true, results });
    } catch (error) {
        console.error(error);
        res.status(500).json({ success: false, message: error.message });
    }
});

// Delete image
app.delete('/delete/:name', requireAuth, async (req, res) => {
    try {
        const blobName = decodeURIComponent(req.params.name);
        ensureSql();

        const imageResult = await sqlPool.request()
            .input('BlobName', sql.NVarChar(255), blobName)
            .query('SELECT Uploader FROM Images WHERE BlobName = @BlobName');

        const image = imageResult.recordset[0];
        if (!image) {
            return res.status(404).json({ success: false, message: 'Image not found' });
        }
        if (image.Uploader !== req.session.username) {
            return res.status(403).json({ success: false, message: 'You can only delete your own posts' });
        }

        const blockBlobClient = imagesContainer.getBlockBlobClient(blobName);
        await blockBlobClient.delete();
        console.log(`${blobName} deleted successfully`);

        await sqlPool.request()
            .input('BlobName', sql.NVarChar(255), blobName)
            .query('DELETE FROM Images WHERE BlobName = @BlobName');

        res.json({ success: true, message: 'Post deleted successfully' });
    } catch (error) {
        console.error(error);
        res.status(500).json({ success: false, message: error.message });
    }
});

// Like / Unlike
app.post('/api/images/:id/like', requireAuth, async (req, res) => {
    try {
        ensureSql();
        const imageId = parseInt(req.params.id, 10);
        const uploader = req.session.username;

        await sqlPool.request()
            .input('ImageId', sql.Int, imageId)
            .input('Uploader', sql.NVarChar(100), uploader)
            .query(`
                IF NOT EXISTS (SELECT 1 FROM Likes WHERE ImageId = @ImageId AND Uploader = @Uploader)
                INSERT INTO Likes (ImageId, Uploader, CreatedAt) VALUES (@ImageId, @Uploader, GETUTCDATE())
            `);

        res.json({ success: true, message: 'Liked' });
    } catch (error) {
        console.error(error);
        res.status(500).json({ success: false, message: error.message });
    }
});

app.post('/api/images/:id/unlike', requireAuth, async (req, res) => {
    try {
        ensureSql();
        const imageId = parseInt(req.params.id, 10);
        const uploader = req.session.username;

        await sqlPool.request()
            .input('ImageId', sql.Int, imageId)
            .input('Uploader', sql.NVarChar(100), uploader)
            .query('DELETE FROM Likes WHERE ImageId = @ImageId AND Uploader = @Uploader');

        res.json({ success: true, message: 'Unliked' });
    } catch (error) {
        console.error(error);
        res.status(500).json({ success: false, message: error.message });
    }
});

// Comments
app.get('/api/images/:id/comments', async (req, res) => {
    try {
        ensureSql();
        const imageId = parseInt(req.params.id, 10);
        const result = await sqlPool.request()
            .input('ImageId', sql.Int, imageId)
            .query(`
                SELECT Id, Uploader, CommentText, CreatedAt
                FROM Comments
                WHERE ImageId = @ImageId
                ORDER BY CreatedAt DESC
            `);

        res.json({ success: true, comments: result.recordset });
    } catch (error) {
        console.error(error);
        res.status(500).json({ success: false, message: error.message });
    }
});

app.post('/api/images/:id/comment', requireAuth, async (req, res) => {
    try {
        ensureSql();
        const imageId = parseInt(req.params.id, 10);
        const uploader = req.session.username;
        const text = (req.body.text || '').trim();

        if (!text) {
            return res.status(400).json({ success: false, message: 'Comment cannot be empty' });
        }
        if (text.length > 1000) {
            return res.status(400).json({ success: false, message: 'Comment is too long' });
        }

        const result = await sqlPool.request()
            .input('ImageId', sql.Int, imageId)
            .input('Uploader', sql.NVarChar(100), uploader)
            .input('CommentText', sql.NVarChar(1000), text)
            .query(`
                INSERT INTO Comments (ImageId, Uploader, CommentText, CreatedAt)
                OUTPUT INSERTED.Id, INSERTED.Uploader, INSERTED.CommentText, INSERTED.CreatedAt
                VALUES (@ImageId, @Uploader, @CommentText, GETUTCDATE())
            `);

        res.json({ success: true, comment: result.recordset[0] });
    } catch (error) {
        console.error(error);
        res.status(500).json({ success: false, message: error.message });
    }
});

app.delete('/api/comments/:id', requireAuth, async (req, res) => {
    try {
        ensureSql();
        const commentId = parseInt(req.params.id, 10);

        const result = await sqlPool.request()
            .input('Id', sql.Int, commentId)
            .query('SELECT Uploader FROM Comments WHERE Id = @Id');

        const comment = result.recordset[0];
        if (!comment) {
            return res.status(404).json({ success: false, message: 'Comment not found' });
        }
        if (comment.Uploader !== req.session.username) {
            return res.status(403).json({ success: false, message: 'You can only delete your own comments' });
        }

        await sqlPool.request()
            .input('Id', sql.Int, commentId)
            .query('DELETE FROM Comments WHERE Id = @Id');

        res.json({ success: true, message: 'Comment deleted' });
    } catch (error) {
        console.error(error);
        res.status(500).json({ success: false, message: error.message });
    }
});

// Analytics
app.get('/api/analytics', async (req, res) => {
    try {
        if (!sqlPool) {
            return res.json({ success: false, message: 'SQL not connected' });
        }

        const [
            countResult,
            sizeResult,
            topUploaderResult,
            latestResult,
            mostLikedResult,
            perUserResult,
            trendResult,
            tagResult,
            userCountResult,
            activityResult,
            likesResult,
            commentsResult
        ] = await Promise.all([
            sqlPool.request().query('SELECT COUNT(*) AS total FROM Images'),
            sqlPool.request().query('SELECT ISNULL(SUM(FileSize), 0) AS totalBytes FROM Images'),
            sqlPool.request().query(`
                SELECT TOP 1 Uploader, COUNT(*) AS count
                FROM Images GROUP BY Uploader ORDER BY count DESC
            `),
            sqlPool.request().query(`
                SELECT TOP 1 Id, FileName, BlobName, Uploader, UploadTime
                FROM Images ORDER BY UploadTime DESC
            `),
            sqlPool.request().query(`
                SELECT TOP 1 i.Id, i.FileName, i.BlobName, i.Uploader, COUNT(l.Id) AS likeCount
                FROM Images i
                LEFT JOIN Likes l ON i.Id = l.ImageId
                GROUP BY i.Id, i.FileName, i.BlobName, i.Uploader
                ORDER BY likeCount DESC
            `),
            sqlPool.request().query(`
                SELECT Uploader, COUNT(*) AS count, ISNULL(SUM(FileSize), 0) AS totalBytes
                FROM Images GROUP BY Uploader ORDER BY count DESC
            `),
            sqlPool.request().query(`
                SELECT CAST(UploadTime AS DATE) AS date, COUNT(*) AS count
                FROM Images
                WHERE UploadTime >= DATEADD(day, -13, GETUTCDATE())
                GROUP BY CAST(UploadTime AS DATE)
                ORDER BY date
            `),
            sqlPool.request().query(`
                SELECT value AS tag, COUNT(*) AS count
                FROM Images
                CROSS APPLY STRING_SPLIT(Tags, ',')
                WHERE Tags IS NOT NULL AND value <> ''
                GROUP BY value
                ORDER BY count DESC
            `),
            sqlPool.request().query('SELECT COUNT(*) AS total FROM Users WHERE IsActive = 1'),
            sqlPool.request().query(`
                SELECT Uploader, COUNT(*) AS count
                FROM Images
                WHERE UploadTime >= DATEADD(day, -30, GETUTCDATE())
                GROUP BY Uploader
                ORDER BY count DESC
            `),
            sqlPool.request().query('SELECT COUNT(*) AS total FROM Likes'),
            sqlPool.request().query('SELECT COUNT(*) AS total FROM Comments')
        ]);

        const totalImages = countResult.recordset[0].total;
        const totalBytes = sizeResult.recordset[0].totalBytes;
        const topUploader = topUploaderResult.recordset[0] || null;
        const latest = latestResult.recordset[0] || null;
        const mostLiked = mostLikedResult.recordset[0] || null;
        const perUser = perUserResult.recordset;
        const trends = trendResult.recordset;
        const mostUsedTags = tagResult.recordset.slice(0, 12);
        const totalUsers = userCountResult.recordset[0].total;
        const activeUsers = activityResult.recordset;
        const totalLikes = likesResult.recordset[0].total;
        const totalComments = commentsResult.recordset[0].total;

        res.json({
            success: true,
            analytics: {
                totalImages,
                totalBytes,
                totalUsers,
                totalLikes,
                totalComments,
                totalSizeFormatted: formatFileSize(totalBytes),
                topUploader: topUploader ? { name: topUploader.Uploader, count: topUploader.count } : null,
                latestUpload: latest ? {
                    id: latest.Id,
                    fileName: latest.FileName,
                    blobName: latest.BlobName,
                    uploader: latest.Uploader,
                    uploadTime: latest.UploadTime
                } : null,
                mostLikedPost: mostLiked ? {
                    id: mostLiked.Id,
                    fileName: mostLiked.FileName,
                    blobName: mostLiked.BlobName,
                    uploader: mostLiked.Uploader,
                    likeCount: mostLiked.likeCount
                } : null,
                mostUsedTags,
                perUser: perUser.map(u => ({
                    uploader: u.Uploader,
                    count: u.count,
                    totalBytes: u.totalBytes,
                    sizeFormatted: formatFileSize(u.totalBytes)
                })),
                activeUsers: activeUsers.map(u => ({
                    uploader: u.Uploader,
                    count: u.count
                })),
                trends: trends.map(t => ({ date: t.date, count: t.count }))
            }
        });
    } catch (error) {
        console.error(error);
        res.status(500).json({ success: false, message: error.message });
    }
});

// Explore
app.get('/api/explore', optionalAuth, async (req, res) => {
    try {
        const images = await buildImageList(req.currentUser);

        const tagCounts = {};
        images.forEach(img => {
            img.tags.forEach(tag => {
                tagCounts[tag] = (tagCounts[tag] || 0) + 1;
            });
        });

        const popularTags = Object.entries(tagCounts)
            .map(([tag, count]) => ({ tag, count }))
            .sort((a, b) => b.count - a.count)
            .slice(0, 12);

        const trending = [...images]
            .sort((a, b) => b.likeCount - a.likeCount || new Date(b.uploadTime) - new Date(a.uploadTime))
            .slice(0, 12);

        const recent = images.slice(0, 12);

        res.json({
            success: true,
            explore: {
                trending,
                recent,
                popularTags,
                totalImages: images.length
            }
        });
    } catch (error) {
        console.error(error);
        res.status(500).json({ success: false, message: error.message });
    }
});

// User profile stats
app.get('/api/users/:uploader/stats', optionalAuth, async (req, res) => {
    try {
        if (!sqlPool) {
            return res.json({ success: false, message: 'SQL not connected' });
        }

        const uploader = decodeURIComponent(req.params.uploader);
        const user = await getUserByUsername(uploader);

        const [postsResult, likesResult] = await Promise.all([
            sqlPool.request()
                .input('Uploader', sql.NVarChar(100), uploader)
                .query('SELECT COUNT(*) AS total FROM Images WHERE Uploader = @Uploader'),
            sqlPool.request()
                .input('Uploader', sql.NVarChar(100), uploader)
                .query(`
                    SELECT COUNT(*) AS total FROM Likes l
                    INNER JOIN Images i ON l.ImageId = i.Id
                    WHERE i.Uploader = @Uploader
                `)
        ]);

        const posts = postsResult.recordset[0].total;
        const likesReceived = likesResult.recordset[0].total;

        const imagesResult = await sqlPool.request()
            .input('Uploader', sql.NVarChar(100), uploader)
            .query(`
                SELECT i.Id, i.FileName, i.BlobName, i.UploadTime, i.FileSize, i.Uploader, i.Tags, i.Caption,
                    (SELECT COUNT(*) FROM Likes WHERE ImageId = i.Id) AS LikeCount,
                    (SELECT COUNT(*) FROM Comments WHERE ImageId = i.Id) AS CommentCount
                FROM Images i
                WHERE i.Uploader = @Uploader
                ORDER BY i.UploadTime DESC
            `);

        const images = imagesResult.recordset.map(row => ({
            id: row.Id,
            fileName: row.FileName,
            blobName: row.BlobName,
            uploadTime: row.UploadTime,
            fileSize: row.FileSize,
            uploader: row.Uploader,
            tags: row.Tags ? row.Tags.split(',').filter(Boolean) : [],
            caption: row.Caption || '',
            likeCount: row.LikeCount || 0,
            commentCount: row.CommentCount || 0
        }));

        res.json({
            success: true,
            profile: {
                uploader,
                bio: user?.Bio || '',
                avatar: user?.ProfilePicture || null,
                joined: user ? formatDate(user.JoinDate) : (posts ? 'Member' : 'New to Pixora'),
                posts,
                likesReceived,
                images
            }
        });
    } catch (error) {
        console.error(error);
        res.status(500).json({ success: false, message: error.message });
    }
});

// Search
app.get('/api/search', optionalAuth, async (req, res) => {
    try {
        const query = (req.query.q || '').trim().toLowerCase();
        let images = await buildImageList(req.currentUser);

        if (query) {
            images = images.filter(img =>
                (img.fileName || '').toLowerCase().includes(query) ||
                (img.uploader || '').toLowerCase().includes(query) ||
                img.tags.some(tag => tag.toLowerCase().includes(query)) ||
                (img.caption || '').toLowerCase().includes(query)
            );
        }

        res.json({ success: true, images, query });
    } catch (error) {
        console.error(error);
        res.status(500).json({ success: false, message: error.message });
    }
});

// Stream image route
app.get('/image/:name', async (req, res) => {
    try {
        const blobName = req.params.name;
        const blockBlobClient = imagesContainer.getBlockBlobClient(blobName);
        const downloadResponse = await blockBlobClient.download();
        downloadResponse.readableStreamBody.pipe(res);
    } catch (error) {
        console.error(error);
        res.status(404).send('Image not found');
    }
});

// Stream avatar route
app.get('/avatar/:name', async (req, res) => {
    try {
        const blobName = req.params.name;
        const blockBlobClient = avatarsContainer.getBlockBlobClient(blobName);
        const downloadResponse = await blockBlobClient.download();
        downloadResponse.readableStreamBody.pipe(res);
    } catch (error) {
        console.error(error);
        res.status(404).send('Avatar not found');
    }
});

// SPA shell
app.get('/', (req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// Start Server
startup().catch(console.error);
