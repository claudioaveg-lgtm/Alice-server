const express = require('express');
const fetch = require('node-fetch');
const WebSocket = require('ws');
const { createClient, LiveTranscriptionEvents } = require('@deepgram/sdk');
const twilio = require('twilio');

const app = express();
app.use(express.urlencoded({ extended: true }));
app.use(express.json());

const {
  GROQ_API_KEY,
  DEEPGRAM_API_KEY,
  TWILIO_ACCOUNT_SID,
  TWILIO_AUTH_TOKEN,
  TWILIO_PHONE_NUMBER,
  MY_PHONE_NUMBER,
  YOUR_NAME = 'Abraham',
} = process.env;

const twilioClient = twilio(TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN);
const deepgramClient = createClient(DEEPGRAM_API_KEY);
const activeCalls = new Map();

const ALICE_SYSTEM_PROMPT = `You are Alice, a personal AI assistant answering calls on behalf of ${YOUR_NAME}.
Your job:
- Answer warmly and professionally
- Find out who is calling and why
- Let them know ${YOUR_NAME} is unavailable but you'll pass the message
- Collect their name, phone number, and message
- Keep responses SHORT — 1-3 sentences max
- Sound natural and human
- Once you have their info, wrap up politely
Opening line: "Hi, you've reached ${YOUR_NAME}'s phone, this is Alice. He's not available right now — can I take a message for him?"
When done, end with: "Perfect, I'll make sure ${YOUR_NAME} gets this message right away. Have a great day!"`;

app.get('/ping', (req, res) => res.json({ status: 'alive', name: 'Alice' }));

app.get('/status', (req, res) => res.json({
  enabled: true,
  activeCall: null,
  stats: { handled: 0, forwarded: 0, urgent: 0, messages: 0 }
}));
app.post('/incoming-call', async (req, res) => {
  const callSid = req.body.CallSid;
  const callerNumber = req.body.From || 'Unknown';

  console.log(`Incoming call from ${callerNumber}`);

  activeCalls.set(callSid, {
    messages: [],
    callerNumber,
    transcript: [],
    summaryItems: { callerName: null, callerMessage: null, urgent: false }
  });

  const host = req.headers.host;
  const twiml = `<?xml version="1.0" encoding="UTF-8"?>
<Response>
  <Connect>
    <Stream url="wss://${host}/media-stream">
      <Parameter name="callSid" value="${callSid}"/>
      <Parameter name="callerNumber" value="${callerNumber}"/>
    </Stream>
  </Connect>
</Response>`;

  res.type('text/xml').send(twiml);
});

const wss = new WebSocket.Server({ noServer: true });

wss.on('connection', async (ws, req) => {
  let callSid = null;
  let callerNumber = null;
  let dgConnection = null;
  let streamSid = null;
  let currentUtterance = '';
  let isAliceSpeaking = false;

  const setupDeepgram = () => {
    dgConnection = deepgramClient.listen.live({
      model: 'nova-2',
      language: 'en-US',
      smart_format: true,
      encoding: 'mulaw',
      sample_rate: 8000,
      channels: 1,
      interim_results: true,
      utterance_end_ms: 1200,
      vad_events: true,
    });

    dgConnection.on(LiveTranscriptionEvents.Open, () => {
      console.log('Deepgram connected');
    });

    dgConnection.on(LiveTranscriptionEvents.Transcript, async (data) => {
      const transcript = data.channel?.alternatives?.[0]?.transcript;
      if (!transcript || isAliceSpeaking) return;
      if (data.is_final) currentUtterance += ' ' + transcript;
      if (data.type === 'UtteranceEnd' && currentUtterance.trim()) {
        const userText = currentUtterance.trim();
        currentUtterance = '';
        console.log(`Caller: ${userText}`);
        const call = activeCalls.get(callSid);
        if (call) {
          call.transcript.push({ role: 'caller', text: userText });
          await getAliceResponse(userText, callSid, streamSid, ws);
        }
      }
    });

    dgConnection.on(LiveTranscriptionEvents.Error, (err) => {
      console.error('Deepgram error:', err);
    });
  };

  setupDeepgram();

  ws.on('message', async (message) => {
    const data = JSON.parse(message);
    switch (data.event) {
      case 'start':
        streamSid = data.start.streamSid;
        callSid = data.start.customParameters?.callSid;
        callerNumber = data.start.customParameters?.callerNumber;
        setTimeout(() => {
          speakAlice(
            `Hi, you've reached ${YOUR_NAME}'s phone, this is Alice. He's not available right now — can I take a message for him?`,
            callSid, streamSid, ws
          );
        }, 800);
        break;
      case 'media':
        if (dgConnection && !isAliceSpeaking) {
          const audioBuffer = Buffer.from(data.media.payload, 'base64');
          dgConnection.send(audioBuffer);
        }
        break;
      case 'stop':
        console.log(`Call ended: ${callSid}`);
        if (dgConnection) dgConnection.finish();
        await sendCallSummary(callSid);
        activeCalls.delete(callSid);
        break;
    }
  });

  ws.on('close', () => {
    if (dgConnection) dgConnection.finish();
  });
});
async function getAliceResponse(userMessage, callSid, streamSid, ws) {
  const call = activeCalls.get(callSid);
  if (!call) return;

  call.messages.push({ role: 'user', content: userMessage });

  try {
    const response = await fetch('https://api.groq.com/openai/v1/chat/completions', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${GROQ_API_KEY}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        model: 'llama-3.3-70b-versatile',
        messages: [
          { role: 'system', content: ALICE_SYSTEM_PROMPT },
          ...call.messages
        ],
        max_tokens: 150,
        temperature: 0.7,
      }),
    });

    const data = await response.json();
    const aliceText = data.choices?.[0]?.message?.content;
    if (!aliceText) return;

    console.log(`Alice: ${aliceText}`);
    call.messages.push({ role: 'assistant', content: aliceText });
    call.transcript.push({ role: 'alice', text: aliceText });

    if (userMessage.toLowerCase().includes('urgent') ||
        userMessage.toLowerCase().includes('emergency')) {
      call.summaryItems.urgent = true;
    }

    await speakAlice(aliceText, callSid, streamSid, ws);

    if (aliceText.includes('Have a great day')) {
      setTimeout(() => hangUp(callSid), 4000);
    }

  } catch (err) {
    console.error('Groq error:', err);
  }
}

async function speakAlice(text, callSid, streamSid, ws) {
  try {
    const response = await fetch('https://api.deepgram.com/v1/speak?model=aura-asteria-en&encoding=mulaw&sample_rate=8000', {
      method: 'POST',
      headers: {
        'Authorization': `Token ${DEEPGRAM_API_KEY}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ text }),
    });

    if (!response.ok) return;

    const audioBuffer = await response.buffer();
    const base64Audio = audioBuffer.toString('base64');

    if (ws.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify({
        event: 'media',
        streamSid,
        media: { payload: base64Audio }
      }));
    }
  } catch (err) {
    console.error('TTS error:', err);
  }
}

async function sendCallSummary(callSid) {
  const call = activeCalls.get(callSid);
  if (!call) return;

  const transcriptText = call.transcript
    .map(t => `${t.role === 'alice' ? 'Alice' : 'Caller'}: ${t.text}`)
    .join('\n');

  let summary = '';
  try {
    const response = await fetch('https://api.groq.com/openai/v1/chat/completions', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${GROQ_API_KEY}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        model: 'llama-3.3-70b-versatile',
        messages: [{
          role: 'user',
          content: `Summarize this call in 3-4 lines. Include: caller name, their number if mentioned, why they called, any action needed.\n\n${transcriptText}`
        }],
        max_tokens: 120,
        temperature: 0.3,
      }),
    });
    const data = await response.json();
    summary = data.choices?.[0]?.message?.content || 'No summary available.';
  } catch {
    summary = `Caller from ${call.callerNumber} left a message.`;
  }

  const urgent = call.summaryItems.urgent ? '🚨 URGENT\n' : '';
  const smsBody = `📞 Missed Call — Alice took a message\n${urgent}From: ${call.callerNumber}\n\n${summary}`;

  try {
    await twilioClient.messages.create({
      body: smsBody,
      from: TWILIO_PHONE_NUMBER,
      to: MY_PHONE_NUMBER,
    });
    console.log('Summary SMS sent');
  } catch (err) {
    console.error('SMS error:', err);
  }
}

async function hangUp(callSid) {
  try {
    await twilioClient.calls(callSid).update({ status: 'completed' });
  } catch (err) {
    console.error('Hangup error:', err);
  }
}

const PORT = process.env.PORT || 3000;
const server = app.listen(PORT, () => {
  console.log(`Alice running on port ${PORT}`);
});

server.on('upgrade', (request, socket, head) => {
  if (request.url === '/media-stream') {
    wss.handleUpgrade(request, socket, head, (ws) => {
      wss.emit('connection', ws, request);
    });
  }
});
