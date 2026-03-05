const BASE = '';

async function request(path, options = {}) {
  const res = await fetch(`${BASE}${path}`, {
    credentials: 'include',
    headers: { 'Content-Type': 'application/json', ...options.headers },
    ...options,
  });
  if (!res.ok) {
    let message;
    const text = await res.text().catch(() => '');
    try {
      const json = JSON.parse(text);
      message = json.error;
    } catch {
      message = text || res.statusText;
    }
    throw new Error(`${res.status}: ${message || 'Request failed'}`);
  }
  return res.json();
}

// App auth
export function register(email, password, displayName) {
  return request('/api/register', {
    method: 'POST',
    body: JSON.stringify({ email, password, display_name: displayName || undefined }),
  });
}

export function signin(email, password) {
  return request('/api/signin', {
    method: 'POST',
    body: JSON.stringify({ email, password }),
  });
}

export function signout() {
  return request('/api/signout', { method: 'POST' });
}

// IMAP connect
export function connect(email, password, overrides = {}) {
  return request('/api/connect', {
    method: 'POST',
    body: JSON.stringify({ email, password, ...overrides }),
  });
}

// Auth status (both app + IMAP)
export function getStatus() {
  return request('/api/auth/status');
}

// Emails
export function getEmails(since) {
  const params = since ? `?since=${since}` : '';
  return request(`/api/emails${params}`);
}

export function getEmail(uid) {
  return request(`/api/emails/${uid}`);
}

export function setWatermark(uid) {
  return request('/api/watermark', {
    method: 'PUT',
    body: JSON.stringify({ uid }),
  });
}

export function searchEmails(query) {
  return request(`/api/search?q=${encodeURIComponent(query)}`);
}

// Remembered
export function getRemembered() {
  return request('/api/remembered');
}

export function rememberEmail(uid, data) {
  return request(`/api/remembered/${uid}`, {
    method: 'POST',
    body: JSON.stringify(data),
  });
}

export function forgetEmail(uid) {
  return request(`/api/remembered/${uid}`, { method: 'DELETE' });
}
