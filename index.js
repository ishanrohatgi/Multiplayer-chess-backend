const express = require('express');
const { Server } = require('socket.io');
const http = require('http');
const cors = require('cors');
const { v4: uuidV4 } = require('uuid');
const { Chess } = require('chess.js');

const app = express();
const server = http.createServer(app);

// Configure CORS for Express
app.use(cors({
  origin: ['http://localhost:3000', 'http://127.0.0.1:3000'],
  credentials: true,
}));

app.use(express.json());

// Configure Socket.io with CORS
const io = new Server(server, {
  cors: {
    origin: ['http://localhost:3000', 'http://127.0.0.1:3000'],
    methods: ['GET', 'POST'],
    credentials: true,
  }
});

// In-memory storage for rooms and games
const rooms = new Map();
const games = new Map();

// Utility functions
const generateRoomId = () => uuidV4().substring(0, 8).toUpperCase();

const cleanupRoom = (roomId) => {
  const room = rooms.get(roomId);
  if (room && room.players.length === 0) {
    rooms.delete(roomId);
    games.delete(roomId);
    console.log(`Room ${roomId} cleaned up`);
  }
};

// Express routes
app.get('/', (req, res) => {
  res.json({
    message: 'Chess Game Server',
    version: '1.0.0',
    status: 'running',
    activeRooms: rooms.size,
    timestamp: new Date().toISOString(),
  });
});

app.get('/api/rooms', (req, res) => {
  const roomList = Array.from(rooms.values()).map(room => ({
    roomId: room.roomId,
    playerCount: room.players.length,
    status: room.status,
    created: room.created,
  }));

  res.json({
    rooms: roomList,
    total: roomList.length,
  });
});

// Socket.io connection handling
io.on('connection', (socket) => {
  console.log(`User connected: ${socket.id}`);

  // Handle username setting
  socket.on('username', (username) => {
    socket.data.username = username;
    console.log(`User ${socket.id} set username: ${username}`);
  });

  // Handle room creation
  socket.on('createRoom', (callback) => {
    try {
      const roomId = generateRoomId();

      const room = {
        roomId,
        players: [{
          socketId: socket.id,
          username: socket.data.username || 'Anonymous',
          color: 'white',
          ready: false,
        }],
        status: 'waiting',
        created: new Date().toISOString(),
        lastActivity: new Date().toISOString(),
      };

      const chess = new Chess();
      games.set(roomId, {
        chess,
        gameState: 'waiting',
        currentTurn: 'white',
        moveCount: 0,
        history: [],
      });

      rooms.set(roomId, room);
      socket.join(roomId);

      console.log(`Room created: ${roomId} by ${socket.data.username}`);
      callback(roomId);
    } catch (error) {
      console.error('Error creating room:', error);
      callback({ error: true, message: 'Failed to create room' });
    }
  });

  // Handle room joining
  socket.on('joinRoom', (args, callback) => {
    try {
      const { roomId } = args;
      const room = rooms.get(roomId);

      if (!room) {
        callback({ error: true, message: 'Room not found' });
        return;
      }
      if (room.players.length >= 2) {
        callback({ error: true, message: 'Room is full' });
        return;
      }
      if (room.players.some(player => player.socketId === socket.id)) {
        callback({ error: true, message: 'Already in this room' });
        return;
      }

      const newPlayer = {
        socketId: socket.id,
        username: socket.data.username || 'Anonymous',
        color: 'black',
        ready: false,
      };

      room.players.push(newPlayer);
      room.status = 'ready';
      room.lastActivity = new Date().toISOString();

      const game = games.get(roomId);
      if (game) {
        game.gameState = 'active';
      }

      socket.join(roomId);

      console.log(`${socket.data.username} joined room: ${roomId}`);

      callback(room);
      socket.to(roomId).emit('opponentJoined', room);
    } catch (error) {
      console.error('Error joining room:', error);
      callback({ error: true, message: 'Failed to join room' });
    }
  });

  // Handle chess moves
  socket.on('move', (data) => {
    try {
      const { move, room: roomId } = data;
      console.log(`Move received in room ${roomId}:`, move);

      const room = rooms.get(roomId);
      const game = games.get(roomId);

      if (!room || !game) {
        socket.emit('error', { message: 'Room or game not found' });
        return;
      }

      const player = room.players.find(p => p.socketId === socket.id);
      if (!player) {
        socket.emit('error', { message: 'Player not found in room' });
        return;
      }

      const currentTurn = game.chess.turn() === 'w' ? 'white' : 'black';
      if (player.color !== currentTurn) {
        socket.emit('error', { message: 'Not your turn' });
        return;
      }

      // Validate move
      const result = game.chess.move(move);
      if (!result) {
        socket.emit('error', { message: 'Invalid move' });
        return;
      }

      console.log(`Valid move processed: ${result.san}`);

      // Update game state
      game.moveCount++;
      game.currentTurn = game.chess.turn() === 'w' ? 'white' : 'black';
      game.history.push({
        move: result,
        fen: game.chess.fen(),
        timestamp: new Date().toISOString(),
        player: player.username,
      });

      room.lastActivity = new Date().toISOString();

      // Check for game over
      let gameOverData = null;
      if (game.chess.isGameOver()) {
        game.gameState = 'finished';

        if (game.chess.isCheckmate()) {
          const winner = game.chess.turn() === 'w' ? 'black' : 'white';
          gameOverData = {
            type: 'checkmate',
            winner,
            message: `Checkmate! ${winner} wins!`,
          };
          console.log(`Game over: ${gameOverData.message}`);
        } else if (game.chess.isDraw()) {
          gameOverData = {
            type: 'draw',
            message: 'Game ended in a draw',
          };
          console.log(`Game over: Draw`);
        }
      }

      // Broadcast move to others
      socket.to(roomId).emit('move', move);
      console.log(`Move broadcasted to room ${roomId} (excluding sender)`);

      // Emit game update to all
      const moveData = {
        fen: game.chess.fen(),
        currentTurn: game.currentTurn,
        moveCount: game.moveCount,
        gameOver: gameOverData,
        lastMove: result,
      };
      io.to(roomId).emit('gameUpdate', moveData);

    } catch (error) {
      console.error('Error handling move:', error);
      socket.emit('error', { message: 'Failed to process move' });
    }
  });

  // Handle game reset
  socket.on('gameReset', (data) => {
    try {
      const { room: roomId } = data;
      const room = rooms.get(roomId);
      const game = games.get(roomId);

      if (!room || !game) return;

      game.chess.reset();
      game.gameState = 'active';
      game.currentTurn = 'white';
      game.moveCount = 0;
      game.history = [];

      room.lastActivity = new Date().toISOString();

      io.to(roomId).emit('gameReset');

      const resetData = {
        fen: game.chess.fen(),
        currentTurn: 'white',
        moveCount: 0,
        gameOver: null,
      };

      io.to(roomId).emit('gameUpdate', resetData);

      console.log(`Game reset in room: ${roomId}`);
    } catch (error) {
      console.error('Error resetting game:', error);
    }
  });

  // Handle player disconnect
  socket.on('disconnect', (reason) => {
    console.log(`User disconnected: ${socket.id} - Reason: ${reason}`);

    for (const [roomId, room] of rooms.entries()) {
      const playerIndex = room.players.findIndex(player => player.socketId === socket.id);

      if (playerIndex !== -1) {
        const disconnectedPlayer = room.players[playerIndex];
        room.players.splice(playerIndex, 1);
        room.lastActivity = new Date().toISOString();

        console.log(`${disconnectedPlayer.username} left room: ${roomId}`);

        // Notify remaining players
        if (room.players.length > 0) {
          socket.to(roomId).emit('playerDisconnected', {
            player: disconnectedPlayer,
            remainingPlayers: room.players.length,
          });
        }

        cleanupRoom(roomId);
        break;
      }
    }
  });

  // Handle ping for connection testing
  socket.on('ping', (callback) => {
    if (callback && typeof callback === 'function') {
      callback('pong');
    }
  });
});

// Periodically cleanup inactive rooms
setInterval(() => {
  const now = new Date();
  const maxInactiveTime = 30 * 60 * 1000; // 30 minutes

  for (const [roomId, room] of rooms.entries()) {
    const lastActivity = new Date(room.lastActivity);
    if (now - lastActivity > maxInactiveTime) {
      console.log(`Cleaning up inactive room: ${roomId}`);
      rooms.delete(roomId);
      games.delete(roomId);
    }
  }
}, 5 * 60 * 1000); // every 5 minutes

// Express error middleware
app.use((err, req, res, next) => {
  console.error('Express error:', err);
  res.status(500).json({ error: 'Internal server error' });
});

// Start server
const PORT = process.env.PORT || 8080;
server.listen(PORT, () => {
  console.log(`Chess Game Server started on port ${PORT}`);
  console.log(`Health check: http://localhost:${PORT}/api/rooms`);
  console.log('WebSocket server ready for connections');
});

// Graceful shutdown
process.on('SIGTERM', () => {
  console.log('Received SIGTERM, shutting down...');
  server.close(() => {
    console.log('Server closed');
    process.exit(0);
  });
});

process.on('SIGINT', () => {
  console.log('Received SIGINT, shutting down...');
  server.close(() => {
    console.log('Server closed');
    process.exit(0);
  });
});
