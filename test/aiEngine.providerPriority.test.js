const test = require('node:test');
const assert = require('node:assert/strict');

process.env.SUPABASE_URL = process.env.SUPABASE_URL || 'https://example.supabase.co';
process.env.SUPABASE_KEY = process.env.SUPABASE_KEY || 'test-key';

const { getProviderOrder } = require('../aiEngine');

test('prioritizes Gemini then Claude gateway before Groq for customer-service replies', () => {
    assert.deepEqual(getProviderOrder({
        hasGemini: true,
        hasOpenAgentic: true,
        hasGroq: true,
    }), ['gemini', 'openagentic', 'groq']);
});

test('skips unavailable providers without changing the remaining CS model priority', () => {
    assert.deepEqual(getProviderOrder({
        hasGemini: false,
        hasOpenAgentic: true,
        hasGroq: true,
    }), ['openagentic', 'groq']);
});
