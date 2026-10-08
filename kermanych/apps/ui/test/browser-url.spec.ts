import { describe, expect, it } from 'vitest';
import { addressToUrl, isExternalScheme, navigationAllowed, normalizeUrl } from '../src/lib/browser-url';

describe('normalizeUrl', () => {
  it('gives a bare local host http:// and any other bare host https://', () => {
    expect(normalizeUrl('localhost:5173')).toBe('http://localhost:5173/');
    expect(normalizeUrl(' 127.0.0.1:8080/board?x=1 ')).toBe('http://127.0.0.1:8080/board?x=1');
    expect(normalizeUrl('0.0.0.0:3000')).toBe('http://0.0.0.0:3000/');
    expect(normalizeUrl('[::1]:4000')).toBe('http://[::1]:4000/');
    expect(normalizeUrl('example.com/docs')).toBe('https://example.com/docs');
    expect(normalizeUrl('example.com:8443')).toBe('https://example.com:8443/');
  });

  it('keeps http(s), about:blank and data: URLs', () => {
    expect(normalizeUrl('http://example.com')).toBe('http://example.com/');
    expect(normalizeUrl('https://example.com/a#b')).toBe('https://example.com/a#b');
    expect(normalizeUrl('about:blank')).toBe('about:blank');
    expect(normalizeUrl('data:text/html,<p>hi')).toBe('data:text/html,<p>hi');
  });

  it('refuses other schemes, non-URLs and empty input', () => {
    expect(() => normalizeUrl('')).toThrow('No URL to open');
    expect(() => normalizeUrl('   ')).toThrow('No URL to open');
    expect(() => normalizeUrl('file:///etc/hosts')).toThrow('Only http(s) pages open in the session browser, not file:');
    expect(() => normalizeUrl('javascript:alert(1)')).toThrow('not javascript:');
    expect(() => normalizeUrl('mailto:a@b.c')).toThrow('not mailto:');
    expect(() => normalizeUrl('http://')).toThrow('Not a URL: http://');
  });
});

describe('addressToUrl', () => {
  it('opens URL-looking entries as normalizeUrl reads them', () => {
    expect(addressToUrl('localhost:3000')).toBe('http://localhost:3000/');
    expect(addressToUrl('github.com/anthropics')).toBe('https://github.com/anthropics');
    expect(addressToUrl('https://example.com')).toBe('https://example.com/');
    expect(addressToUrl('about:blank')).toBe('about:blank');
  });

  it('searches the web for words and phrases', () => {
    expect(addressToUrl('kermanych')).toBe('https://www.google.com/search?q=kermanych');
    expect(addressToUrl('how to center a div')).toBe('https://www.google.com/search?q=how%20to%20center%20a%20div');
    // A dot inside a phrase does not make it an address.
    expect(addressToUrl('vue 3.5 release')).toBe('https://www.google.com/search?q=vue%203.5%20release');
  });

  it('still refuses schemes the browser does not open', () => {
    expect(() => addressToUrl('file:///etc/hosts')).toThrow('not file:');
    expect(() => addressToUrl('')).toThrow('No URL to open');
  });
});

describe('navigationAllowed', () => {
  it('lets pages navigate to http(s) and about:blank only', () => {
    expect(navigationAllowed('https://example.com/x')).toBe(true);
    expect(navigationAllowed('http://localhost:5173/')).toBe(true);
    expect(navigationAllowed('about:blank')).toBe(true);
    expect(navigationAllowed('data:text/html,hi')).toBe(false);
    expect(navigationAllowed('file:///etc/hosts')).toBe(false);
    expect(navigationAllowed('mailto:a@b.c')).toBe(false);
    expect(navigationAllowed('not a url')).toBe(false);
  });
});

describe('isExternalScheme', () => {
  it('names the links the OS handles', () => {
    expect(isExternalScheme('mailto:a@b.c')).toBe(true);
    expect(isExternalScheme('tel:+380441234567')).toBe(true);
    expect(isExternalScheme('SMS:+1')).toBe(true);
    expect(isExternalScheme('facetime:x')).toBe(true);
    expect(isExternalScheme('callto:x')).toBe(true);
    expect(isExternalScheme('https://example.com')).toBe(false);
    expect(isExternalScheme('javascript:void 0')).toBe(false);
  });
});
