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
      const delay = key === 'notebook' ? 2000 : 500;
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

    listen(key, callback) {
      let cancelled = false;
      client
        .from('planner_data')
        .select('payload')
        .eq('key', key)
        .maybeSingle()
        .then(({ data, error }) => {
          if (cancelled) return;
          if (error && error.code !== 'PGRST116') {
            console.warn('SupabaseSync listen initial:', key, error);
          }
          if (data && data.payload !== undefined) {
            callback(data.payload);
          }
        });

      const filter = `key=eq.${key}`;
      const channel = client
        .channel(`planner_data:${key}`)
        .on(
          'postgres_changes',
          { event: '*', schema: 'public', table: 'planner_data', filter },
          (payload) => {
            const row = payload.new;
            if (row && row.payload !== undefined) {
              callback(row.payload);
            }
          }
        )
        .subscribe();

      return () => {
        cancelled = true;
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
