/** Same-origin, read-only front-end data access. Does not open filesystem paths. */
export class MemoryProvider {
  async read(path, options = {}) {
    const response = await fetch(path, { cache: 'no-store', signal: options.signal });
    const value = await response.json();
    if (!response.ok) throw Object.assign(new Error(value.message ?? '数据读取失败'), { code: value.error });
    return value;
  }
  query(path, values, options) {
    const params = new URLSearchParams();
    for (const [key, value] of Object.entries(values)) if (value !== null && value !== undefined && value !== '') params.set(key, String(value));
    return this.read(`${path}?${params}`, options);
  }
  overview(options) { return this.read('/api/overview', options); }
  graph(values, options) { return this.query('/api/graph', values, options); }
  detail(values, options) { return this.query('/api/detail', values, options); }
  sources(values, options) { return this.query('/api/sources', values, options); }
  recalls(values, options) { return this.query('/api/recalls', values, options); }
}
