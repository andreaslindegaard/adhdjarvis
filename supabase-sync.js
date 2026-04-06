(function () {
  'use strict';

  let client = null;
  const debounceTimers = new Map();

  function getCreateClient() {
    const lib = window.supabase;
    if (!lib || typeof lib.createClient !== 'function') {
      throw new Error('Supabase JS not loaded (expected window.supabase.createClient)');
    }
    return lib.createClient;
  }

  function debounce(key, fn, delay) {
    return new Promise((resolve, reject) => {
      if (debounceTimers.has(key)) {
        clearTimeout(debounceTimers.get(key));
      }
      debounceTimers.set(key, setTimeout(() => {
        debounceTimers.delete(key);
        Promise.resolve(fn()).then(resolve).catch(reject);
      }, delay));
    });
  }

  window.SupabaseSync = {
    init(config) {
      return new Promise((resolve, reject) => {
        try {
          const createClient = getCreateClient();
          if (!config || !config.url || !config.key) {
            reject(new Error('SupabaseSync: url and key required'));
            return;
          }
          client = createClient(config.url, config.key, {
            auth: { persistSession: false, autoRefreshToken: false }
          });
          console.log('SupabaseSync: client ready');
          resolve({ ok: true });
        } catch (err) {
          reject(err);
        }
      });
    },

    save(key, data) {
      const delay = key === 'notebook' ? 2000 : key === 'recurring' ? 0 : 500;
      return debounce(key, () => {
        return client
          .from('planner_data')
          .upsert(
            { key, payload: data, updated_at: new Date().toISOString() },
            { onConflict: 'key' }
          )
          .then(({ error }) => {
            if (error) throw error;
          });
      }, delay);
    },

    fetchKey(key) {
      if (!client) return Promise.resolve(null);
      return client
        .from('planner_data')
        .select('payload, updated_at')
        .eq('key', key)
        .maybeSingle()
        .then(({ data, error }) => {
          if (error && error.code !== 'PGRST116') {
            console.warn('SupabaseSync fetchKey:', key, error);
            return null;
          }
          return data || null;
        });
    },

    listen(key, callback) {
      const filter = `key=eq.${key}`;
      const channel = client
        .channel(`planner_data:${key}`)
        .on(
          'postgres_changes',
          { event: '*', schema: 'public', table: 'planner_data', filter },
          (payload) => {
            const row = payload.new;
            if (row && row.payload !== undefined) {
              callback(row.payload, { updated_at: row.updated_at });
            }
          }
        )
        .subscribe();

      return () => {
        if (channel && typeof channel.unsubscribe === 'function') {
          channel.unsubscribe().catch(() => {});
        } else {
          client.removeChannel(channel);
        }
      };
    },

    migrateFromLocalStorage(localData) {
      const keys = ['notes', 'recurring', 'notebook', 'smartLinks', 'notifSettings'];
      return Promise.all(
        keys.map((key) => {
          if (localData[key] === undefined || localData[key] === null) {
            return Promise.resolve();
          }
          return client
            .from('planner_data')
            .select('key')
            .eq('key', key)
            .maybeSingle()
            .then(({ data, error }) => {
              if (error && error.code !== 'PGRST116') throw error;
              if (!data) {
                return client
                  .from('planner_data')
                  .upsert(
                    {
                      key,
                      payload: localData[key],
                      updated_at: new Date().toISOString()
                    },
                    { onConflict: 'key' }
                  )
                  .then(({ error: upErr }) => {
                    if (upErr) throw upErr;
                  });
              }
            });
        })
      );
    }
  };
})();
