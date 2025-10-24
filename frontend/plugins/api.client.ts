export default defineNuxtPlugin(() => {
  const { public: { apiBase, backendBase } } = useRuntimeConfig();

  // Always send cookies (session) to backend
  const call = (path: string, opts: any = {}) =>
    $fetch(path, {
      baseURL: apiBase,        // e.g. http://localhost:3002/api
      credentials: 'include',  // send cookies cross-origin
      ...opts,
    });

  return {
    provide: {
      api: {
        login: () => window.location.assign(`${backendBase}/auth/login`),
        me: () => call('/me'),
        playlists: () => call('/playlists'),
        playlistTracks: (id: string) => call(`/playlists/${id}/tracks`),
      }
    }
  };
});
