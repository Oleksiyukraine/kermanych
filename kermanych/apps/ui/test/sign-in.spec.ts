import { describe, expect, it } from 'vitest';
import { isLoginPage, loginUrlFor } from '../src/lib/sign-in';

describe('loginUrlFor', () => {
  it('puts a login path on the page origin and keeps a full URL', () => {
    expect(loginUrlFor('http://localhost:52571/dashboard?x=1', '/login')).toBe('http://localhost:52571/login');
    expect(loginUrlFor('http://localhost:52571/a/b', 'login')).toBe('http://localhost:52571/a/login');
    expect(loginUrlFor('http://localhost:52571/', 'https://auth.example.com/sign-in')).toBe('https://auth.example.com/sign-in');
  });

  it('is null with no path, off a web page, or for another scheme', () => {
    expect(loginUrlFor('http://localhost:52571/', '  ')).toBeNull();
    expect(loginUrlFor('about:blank', '/login')).toBeNull();
    expect(loginUrlFor('http://localhost:52571/', 'javascript:alert(1)')).toBeNull();
  });
});

describe('isLoginPage', () => {
  it('matches the route whatever the trailing slash and query', () => {
    expect(isLoginPage('http://localhost:52571/login', '/login')).toBe(true);
    expect(isLoginPage('http://localhost:52571/login/?next=%2F', '/login')).toBe(true);
    expect(isLoginPage('http://localhost:52571/#/login?next=1', '/login')).toBe(true);
  });

  it('does not match another route, a deeper one or another origin', () => {
    expect(isLoginPage('http://localhost:52571/dashboard', '/login')).toBe(false);
    expect(isLoginPage('http://localhost:52571/login/reset', '/login')).toBe(false);
    expect(isLoginPage('http://localhost:52571/login', 'https://auth.example.com/login')).toBe(false);
    expect(isLoginPage('http://localhost:52571/login', '')).toBe(false);
  });
});
