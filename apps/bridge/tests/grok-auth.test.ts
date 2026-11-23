import { test, expect, vi } from 'vitest';
import { GrokAuth } from '../src/auth/grok-auth.ts';

function jwt(payload: object) {
  return 'h.' + Buffer.from(JSON.stringify(payload)).toString('base64url') + '.s';
}

function vault() {
  const values = new Map<string, string>();
  return {
    values,
    read: async (key: string) => values.get(key) || '',
    write: async (key: string, value: string) => {
      values.set(key, value);
    },
  };
}

test('device sign-in stores only the refreshable session', async () => {
  const calls: { url: string; body: string }[] = [];
  let polls = 0;
  const secrets = vault();
  const auth = new GrokAuth(secrets, {
    sleep: async () => {},
    fetch: async (input, init) => {
      const url = String(input);
      const body = String(init?.body || '');
      calls.push({ url, body });
      if (url.endsWith('/oauth2/device/code')) {
        return Response.json({
          device_code: 'device-private',
          user_code: 'ABCD-EFGH',
          verification_uri: 'https://accounts.x.ai/device',
          verification_uri_complete: 'https://accounts.x.ai/device?user_code=ABCD-EFGH',
          expires_in: 600,
          interval: 1,
        });
      }
      polls += 1;
      if (polls === 1) {
        return Response.json({ error: 'authorization_pending' }, { status: 400 });
      }
      return Response.json({
        access_token: jwt({ sub: 'user-1', email: 'ada@example.com' }),
        refresh_token: 'refresh-private',
        expires_in: 900,
        scope: 'openid grok-cli:access',
      });
    },
  });
  const started = await auth.beginSignIn();
  expect(started.userCode).toBe('ABCD-EFGH');
  expect(started.authorizationUrl).toBe('https://accounts.x.ai/device?user_code=ABCD-EFGH');
  expect(auth.state().status).toBe('authorizing');
  await vi.waitFor(() => expect(auth.state().status).toBe('connected'));
  expect(auth.state().account).toBe('ada@example.com');
  const saved = secrets.values.get('grok:accounts') || '';
  expect(saved).toContain('refresh-private');
  expect(saved).not.toContain('device-private');
  expect(JSON.stringify(auth.state())).not.toContain('refresh-private');
  expect(calls[0]!.body).toContain('referrer=wisp');
});

test('a hostile verification page is rejected before polling', async () => {
  const auth = new GrokAuth(vault(), {
    fetch: async () =>
      Response.json({
        device_code: 'device-private',
        user_code: 'ABCD-EFGH',
        verification_uri: 'javascript:alert(1)',
      }),
  });
  await expect(auth.beginSignIn()).rejects.toThrow('sign-in page');
  expect(auth.state().status).toBe('signed_out');
});

test('cancel during the credential write restores the previous account', async () => {
  const secrets = vault();
  await secrets.write(
    'grok:accounts',
    JSON.stringify({
      activeId: 'user-1',
      profiles: [
        {
          id: 'user-1',
          email: 'ada@example.com',
          tokens: {
            accessToken: 'old-access',
            refreshToken: 'refresh-old',
            expiresAt: Date.now() + 60_000,
            scopes: ['grok-cli:access'],
          },
        },
      ],
    }),
  );
  const write = secrets.write.bind(secrets);
  let entered = () => {};
  let release = () => {};
  const writing = new Promise<void>((resolve) => {
    entered = resolve;
  });
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  secrets.write = async (key, value) => {
    if (value.includes('refresh-private')) {
      entered();
      await gate;
    }
    await write(key, value);
  };
  const auth = new GrokAuth(secrets, {
    sleep: async () => {},
    fetch: async (input) => {
      if (String(input).endsWith('/device/code')) {
        return Response.json({
          device_code: 'device-private',
          user_code: 'WISP-CODE',
          verification_uri: 'https://auth.x.ai/device',
          interval: 1,
          expires_in: 600,
        });
      }
      return Response.json({
        access_token: jwt({ sub: 'user-2', email: 'bob@example.com' }),
        refresh_token: 'refresh-private',
        expires_in: 900,
        scope: 'openid grok-cli:access',
      });
    },
  });
  await auth.load();
  await auth.beginSignIn();
  await writing;
  let cancelled = false;
  const cancel = auth.cancel().then(() => {
    cancelled = true;
  });
  await new Promise((resolve) => setImmediate(resolve));
  expect(cancelled).toBe(false);
  release();
  await cancel;
  expect(auth.state().status).toBe('connected');
  expect(auth.state().account).toBe('ada@example.com');
  expect(auth.state().message).toBe('Sign-in cancelled.');
  const saved = secrets.values.get('grok:accounts') || '';
  expect(saved).toContain('refresh-old');
  expect(saved).not.toContain('refresh-private');
});

test('cancel stops the poll', async () => {
  const auth = new GrokAuth(vault(), {
    sleep: (_ms, signal) =>
      new Promise((_resolve, reject) => {
        signal.addEventListener('abort', () => reject(signal.reason), { once: true });
      }),
    fetch: async (input) => {
      if (String(input).endsWith('/device/code')) {
        return Response.json({
          device_code: 'device-private',
          user_code: 'WISP-CODE',
          verification_uri: 'https://auth.x.ai/device',
          interval: 5,
          expires_in: 600,
        });
      }
      throw Error('should not poll after cancel');
    },
  });
  await auth.beginSignIn();
  await auth.cancel();
  expect(auth.state().status).toBe('signed_out');
  expect(auth.state().message).toBe('Sign-in cancelled.');
});

test('an expired access token is refreshed once', async () => {
  const secrets = vault();
  let now = 1_000_000;
  const auth = new GrokAuth(secrets, {
    now: () => now,
    fetch: async () =>
      Response.json({
        access_token: 'renewed-access',
        refresh_token: 'renewed-refresh',
        expires_in: 900,
        scope: 'api:access',
      }),
  });
  await secrets.write(
    'grok:accounts',
    JSON.stringify({
      activeId: 'user-1',
      profiles: [
        {
          id: 'user-1',
          email: 'ada@example.com',
          tokens: {
            accessToken: 'old-access',
            refreshToken: 'old-refresh',
            expiresAt: now,
            scopes: ['grok-cli:access'],
          },
        },
      ],
    }),
  );
  await auth.load();
  await expect(auth.accessToken()).resolves.toBe('renewed-access');
  expect(secrets.values.get('grok:accounts')).toContain('renewed-refresh');
  expect(secrets.values.get('grok:accounts')).not.toContain('old-refresh');
});

test('a second model-catalog 401 requires a new sign-in', async () => {
  const secrets = vault();
  const now = 1_000_000;
  let models = 0;
  const auth = new GrokAuth(secrets, {
    now: () => now,
    fetch: async (input) => {
      if (String(input).endsWith('/models-v2')) {
        models += 1;
        return new Response('denied', { status: 401 });
      }
      return Response.json({
        access_token: 'renewed-access',
        refresh_token: 'renewed-refresh',
        expires_in: 900,
        scope: 'grok-cli:access',
      });
    },
  });
  await secrets.write(
    'grok:accounts',
    JSON.stringify({
      activeId: 'user-1',
      profiles: [
        {
          id: 'user-1',
          email: 'ada@example.com',
          tokens: {
            accessToken: 'old-access',
            refreshToken: 'old-refresh',
            expiresAt: now + 120_000,
            scopes: ['grok-cli:access'],
          },
        },
      ],
    }),
  );
  await auth.load();
  await expect(auth.models()).rejects.toThrow('Could not load models');
  expect(models).toBe(2);
  expect(auth.state().status).toBe('reauth_required');
  expect(auth.state().message).toBe('Grok rejected this session. Please sign in again.');
  await expect(auth.accessToken()).rejects.toThrow('Sign in with Grok');
});

test('a model-catalog outage leaves the Grok session connected', async () => {
  const secrets = vault();
  const now = 1_000_000;
  const auth = new GrokAuth(secrets, {
    now: () => now,
    fetch: async () => new Response('down', { status: 503 }),
  });
  await secrets.write(
    'grok:accounts',
    JSON.stringify({
      activeId: 'user-1',
      profiles: [
        {
          id: 'user-1',
          email: 'ada@example.com',
          tokens: {
            accessToken: 'old-access',
            refreshToken: 'old-refresh',
            expiresAt: now + 120_000,
            scopes: ['grok-cli:access'],
          },
        },
      ],
    }),
  );
  await auth.load();
  await expect(auth.models()).rejects.toThrow('Could not load models');
  expect(auth.state().status).toBe('connected');
});
