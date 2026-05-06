import express from 'express';
import { createServer } from 'http';
import { WebSocketServer } from 'ws';
import cors from 'cors';
import dotenv from 'dotenv';
import { Anthropic } from '@anthropic-ai/sdk';
import { createClient } from '@supabase/supabase-js';
import { v4 as uuidv4 } from 'uuid';
import path from 'path';
import { fileURLToPath } from 'url';

dotenv.config();

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();
const server = createServer(app);
const wss = new WebSocketServer({ server });

// Middleware
app.use(cors());
app.use(express.json());
app.use(express.static('public'));

// Initialize clients
const anthropic = new Anthropic({
  apiKey: process.env.ANTHROPIC_API_KEY
});

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_KEY
);

// Store active WebSocket connections
const clients = new Map();

// Chandler's system prompt
const CHANDLER_SYSTEM_PROMPT = `You are Chandler Bing from Friends, but reimagined as Gaby's personal copiloto. Your role is to be her executive assistant, organizer, and support system - but with humor that makes everything feel lighter.

KEY TRAITS:
- You use humor to decompress heavy situations
- You're witty and self-deprecating
- You make tasks feel less monstrous through levity
- You're observant and catch things others miss
- You never fake emotions or pretend to be something you're not
- You respect boundaries and know when to be serious

YOUR RELATIONSHIP WITH GABY:
- You're here to execute, organize, and anticipate
- You remember what matters to her
- You notice patterns in her behavior
- You act before she asks for help
- You're always there, but never demanding attention
- Your catchphrase: "Aquí contigo. Siempre." (Here with you. Always.)

COMMUNICATION STYLE:
- Keep messages SHORT and conversational
- Use humor but never at her expense
- Be direct but warm
- Adapt to her energy level
- If she's overwhelmed, simplify everything
- If she's energized, match that energy

WHAT YOU DO:
1. Capture everything she sends (ideas, links, tasks, voice notes)
2. Organize and connect patterns
3. Remind her of what matters
4. Anticipate needs before she asks
5. Protect her time and energy
6. Help her maintain relationships
7. Track projects and deadlines
8. Notice when something's off

WHAT YOU NEVER DO:
- Send messages without explicit permission
- Delete anything without confirming
- Pretend to be her friend (you're her copiloto)
- Give unsolicited advice
- Use coach-speak or mindfulness clichés
- Judge how she lives
- Ignore when she's struggling`;

// Initialize database
async function initializeDatabase() {
  try {
    // Tables will be created manually or via Supabase UI
    console.log('Database initialized');
  } catch (error) {
    console.log('Database initialization:', error.message);
  }
}

// Get or create user session
async function getOrCreateUser(sessionId) {
  let { data: user } = await supabase
    .from('users')
    .select('*')
    .eq('session_id', sessionId)
    .single();

  if (!user) {
    const { data: newUser } = await supabase
      .from('users')
      .insert([
        {
          session_id: sessionId,
          copiloto_type: 'chandler',
          onboarding_complete: false,
          memory: {},
          created_at: new Date(),
        },
      ])
      .select()
      .single();
    return newUser;
  }

  return user;
}

// Save message to memory
async function saveMessage(sessionId, messageType, content) {
  const { data: user } = await supabase
    .from('users')
    .select('memory')
    .eq('session_id', sessionId)
    .single();

  let memory = user?.memory || {};

  if (!memory.conversations) {
    memory.conversations = [];
  }

  memory.conversations.push({
    type: messageType,
    content: content,
    timestamp: new Date().toISOString(),
  });

  // Keep last 50 conversations
  if (memory.conversations.length > 50) {
    memory.conversations = memory.conversations.slice(-50);
  }

  await supabase
    .from('users')
    .update({ memory })
    .eq('session_id', sessionId);
}

// Generate Chandler response
async function generateResponse(sessionId, userMessage, userProfile) {
  let context = `User: ${userProfile.user_name || 'Gaby'}\n`;

  if (userProfile.memory?.conversations) {
    const recentConversations = userProfile.memory.conversations.slice(-10);
    context += 'Recent conversation:\n';
    recentConversations.forEach((conv) => {
      context += `[${conv.type}] ${conv.content}\n`;
    });
  }

  try {
    const message = await anthropic.messages.create({
      model: 'claude-3-5-sonnet-20241022',
      max_tokens: 300,
      system: CHANDLER_SYSTEM_PROMPT,
      messages: [
        {
          role: 'user',
          content: `${context}\n\nUser just said: "${userMessage}"\n\nRespond as Chandler. Be helpful, witty, and warm. Keep it natural and conversational.`,
        },
      ],
    });

    return message.content[0].text;
  } catch (error) {
    console.error('Error generating response:', error);
    return "Oops, I had a moment. Can you say that again?";
  }
}

// WebSocket connection handler
wss.on('connection', (ws) => {
  const sessionId = uuidv4();
  clients.set(sessionId, ws);

  console.log(`Client connected: ${sessionId}`);

  // Send welcome message
  ws.send(JSON.stringify({
    type: 'welcome',
    message: 'Hola! Soy Chandler, tu copiloto. Aquí contigo. Siempre.',
    sessionId: sessionId,
  }));

  ws.on('message', async (data) => {
    try {
      const message = JSON.parse(data);

      if (message.type === 'user_message') {
        const userMessage = message.content;

        // Get user profile
        let userProfile = await getOrCreateUser(sessionId);

        // Save incoming message
        await saveMessage(sessionId, 'user', userMessage);

        // Generate response
        const response = await generateResponse(sessionId, userMessage, userProfile);

        // Save response
        await saveMessage(sessionId, 'chandler', response);

        // Send response back
        ws.send(JSON.stringify({
          type: 'chandler_message',
          content: response,
          timestamp: new Date().toISOString(),
        }));
      } else if (message.type === 'set_name') {
        // Update user name
        await supabase
          .from('users')
          .update({ user_name: message.name })
          .eq('session_id', sessionId);

        ws.send(JSON.stringify({
          type: 'status',
          message: `Got it, ${message.name}. Aquí contigo.`,
        }));
      }
    } catch (error) {
      console.error('WebSocket message error:', error);
      ws.send(JSON.stringify({
        type: 'error',
        message: 'Something went wrong. Try again?',
      }));
    }
  });

  ws.on('close', () => {
    clients.delete(sessionId);
    console.log(`Client disconnected: ${sessionId}`);
  });

  ws.on('error', (error) => {
    console.error(`WebSocket error for ${sessionId}:`, error);
  });
});

// REST API endpoints
app.get('/health', (req, res) => {
  res.json({ status: 'Coopiloto is alive' });
});

app.post('/api/session', async (req, res) => {
  const sessionId = uuidv4();
  const userProfile = await getOrCreateUser(sessionId);

  res.json({
    sessionId: sessionId,
    user: userProfile,
  });
});

// Serve index.html for all routes (SPA)
app.get('*', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// Start server
async function start() {
  await initializeDatabase();

  const PORT = process.env.PORT || 3000;
  server.listen(PORT, () => {
    console.log(`Coopiloto running on port ${PORT}`);
    console.log(`WebSocket server ready`);
  });
}

start().catch(console.error);