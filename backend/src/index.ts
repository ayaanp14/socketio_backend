import express from 'express';
import cors from 'cors';
import { PrismaClient } from '@prisma/client';
import { PrismaPg } from '@prisma/adapter-pg';
import { Pool } from 'pg';
import { OAuth2Client } from 'google-auth-library';
import jwt from 'jsonwebtoken';
import dotenv from 'dotenv';
import http from 'http';
import { Server } from 'socket.io';

dotenv.config();

const app = express();
const server = http.createServer(app);

const io = new Server(server, {
  cors: {
    origin: 'http://localhost:5173',
    methods: ['GET', 'POST'],
    credentials: true,
  }
});

const pool = new Pool({ connectionString: process.env.DATABASE_URL });
const adapter = new PrismaPg(pool);
const prisma = new PrismaClient({ adapter });
const clientId = process.env.GOOGLE_CLIENT_ID;
if (!clientId) {
  console.warn("Warning: GOOGLE_CLIENT_ID is not defined.");
}
const googleClient = new OAuth2Client(clientId || '');

app.use(cors({
  origin: 'http://localhost:5173', // Vite default port
  credentials: true,
}));
app.use(express.json());

const JWT_SECRET = process.env.JWT_SECRET || 'secret';

// Auth middleware
const requireAuth = (req: any, res: any, next: any) => {
  const authHeader = req.headers.authorization;
  if (!authHeader) return res.status(401).json({ error: 'No token' });
  
  const token = authHeader.split(' ')[1];
  try {
    const decoded = jwt.verify(token, JWT_SECRET) as { userId: string };
    req.userId = decoded.userId;
    next();
  } catch (err) {
    res.status(401).json({ error: 'Invalid token' });
  }
};

app.post('/api/auth/google', async (req, res) => {
  const { token } = req.body;
  if (!token) return res.status(400).json({ error: 'Token is required' });

  try {
    const ticket = await googleClient.verifyIdToken({
      idToken: token,
      audience: clientId || '',
    });
    
    const payload = ticket.getPayload();
    if (!payload) throw new Error('No payload found in token');

    const { sub: googleId, email, name, picture } = payload;
    if (!email) return res.status(400).json({ error: 'Email not provided by Google' });

    let user = await prisma.user.findUnique({ where: { googleId } });

    if (!user) {
      user = await prisma.user.create({
        data: { googleId, email, name, avatarUrl: picture },
      });
    }

    const sessionToken = jwt.sign({ userId: user.id }, JWT_SECRET, { expiresIn: '7d' });

    res.json({ user, token: sessionToken });
  } catch (error) {
    console.error('Auth error:', error);
    res.status(401).json({ error: 'Authentication failed' });
  }
});

// Search user by email
app.get('/api/users/search', requireAuth, async (req: any, res) => {
  const { email } = req.query;
  try {
    const user = await prisma.user.findUnique({ where: { email: String(email) } });
    if (!user) return res.status(404).json({ error: 'User not found' });
    res.json({ user });
  } catch (err) {
    res.status(500).json({ error: 'Search failed' });
  }
});

// Send friend request
app.post('/api/friends/request', requireAuth, async (req: any, res) => {
  const { receiverId } = req.body;
  const senderId = req.userId;

  try {
    if (senderId === receiverId) return res.status(400).json({ error: 'Cannot add yourself' });
    
    const existing = await prisma.friendRequest.findFirst({
      where: {
        OR: [
          { senderId, receiverId },
          { senderId: receiverId, receiverId: senderId }
        ]
      }
    });

    if (existing) return res.status(400).json({ error: 'Request already exists' });

    const request = await prisma.friendRequest.create({
      data: { senderId, receiverId },
      include: { sender: true }
    });
    
    io.to(receiverId).emit('friend_request', request);
    
    res.json({ request });
  } catch (err) {
    res.status(500).json({ error: 'Failed to send request' });
  }
});

// Get incoming requests
app.get('/api/friends/requests', requireAuth, async (req: any, res) => {
  try {
    const requests = await prisma.friendRequest.findMany({
      where: { receiverId: req.userId, status: 'PENDING' },
      include: { sender: true }
    });
    res.json({ requests });
  } catch (err) {
    res.status(500).json({ error: 'Failed to get requests' });
  }
});

// Accept friend request
app.post('/api/friends/accept', requireAuth, async (req: any, res) => {
  const { requestId } = req.body;
  try {
    const request = await prisma.friendRequest.findUnique({ where: { id: requestId } });
    if (!request || request.receiverId !== req.userId) return res.status(403).json({ error: 'Invalid request' });

    await prisma.$transaction([
      prisma.friendRequest.update({ where: { id: requestId }, data: { status: 'ACCEPTED' } }),
      prisma.friendship.create({ data: { user1Id: request.senderId, user2Id: request.receiverId } })
    ]);

    const sender = await prisma.user.findUnique({ where: { id: request.senderId } });
    const receiver = await prisma.user.findUnique({ where: { id: request.receiverId } });
    io.to(request.senderId).emit('friend_accepted', receiver);
    io.to(request.receiverId).emit('friend_accepted', sender);

    res.json({ message: 'Accepted' });
  } catch (err) {
    res.status(500).json({ error: 'Failed to accept' });
  }
});

// Get friends
app.get('/api/friends', requireAuth, async (req: any, res) => {
  try {
    const friendships = await prisma.friendship.findMany({
      where: { OR: [{ user1Id: req.userId }, { user2Id: req.userId }] },
      include: { user1: true, user2: true }
    });

    const friends = friendships.map(f => f.user1Id === req.userId ? f.user2 : f.user1);
    res.json({ friends });
  } catch (err) {
    res.status(500).json({ error: 'Failed to get friends' });
  }
});

// Get messages
app.get('/api/messages/:friendId', requireAuth, async (req: any, res) => {
  const { friendId } = req.params;
  const userId = req.userId;
  try {
    const messages = await prisma.message.findMany({
      where: {
        OR: [
          { senderId: userId, receiverId: friendId },
          { senderId: friendId, receiverId: userId }
        ]
      },
      orderBy: { createdAt: 'asc' }
    });
    res.json({ messages });
  } catch (err) {
    res.status(500).json({ error: 'Failed to get messages' });
  }
});

// Socket.IO
io.use((socket, next) => {
  const token = socket.handshake.auth.token;
  if (!token) return next(new Error("Invalid token"));
  try {
    const decoded = jwt.verify(token, JWT_SECRET) as { userId: string };
    socket.data.userId = decoded.userId;
    next();
  } catch (err) {
    next(new Error("Invalid token"));
  }
});

const onlineUsers = new Set<string>();

io.on('connection', (socket) => {
  const userId = socket.data.userId;
  socket.join(userId); // Users join a room with their own ID

  onlineUsers.add(userId);
  io.emit('online_users', Array.from(onlineUsers));

  socket.on('send_message', async (data) => {
    const { receiverId, content } = data;
    try {
      const message = await prisma.message.create({
        data: { senderId: userId, receiverId, content }
      });
      // Emit to receiver
      io.to(receiverId).emit('receive_message', message);
      // Emit back to sender
      socket.emit('receive_message', message);
    } catch (err) {
      console.error(err);
    }
  });

  // WebRTC Signaling
  socket.on('call_user', (data) => {
    console.log(`Call initiated from ${userId} to ${data.to}`);
    io.to(data.to).emit('incoming_call', { from: userId, offer: data.offer });
  });

  socket.on('answer_call', (data) => {
    console.log(`Call answered by ${userId} for ${data.to}`);
    io.to(data.to).emit('call_answered', { answer: data.answer });
  });

  socket.on('ice_candidate', (data) => {
    console.log(`ICE candidate from ${userId} to ${data.to}`);
    io.to(data.to).emit('ice_candidate', { candidate: data.candidate });
  });

  socket.on('end_call', (data) => {
    console.log(`Call ended by ${userId}`);
    io.to(data.to).emit('call_ended');
  });

  socket.on('disconnect', () => {
    setTimeout(() => {
      const userRoom = io.sockets.adapter.rooms.get(userId);
      if (!userRoom || userRoom.size === 0) {
        onlineUsers.delete(userId);
        io.emit('online_users', Array.from(onlineUsers));
      }
    }, 100);
  });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});
