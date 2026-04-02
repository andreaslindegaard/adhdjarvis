(function () {
  'use strict';

  let db = null;
  const debounceTimers = new Map();

  // Hardcoded user ID — all devices share this, no login needed
  const FIXED_UID = 'x7MREQolWQcy1bd7ZbUUct7evRL2';

  function docRef(key) {
    return db.collection('users').doc(FIXED_UID).collection('data').doc(key);
  }

  function debounce(key, fn, delay) {
    return new Promise((resolve, reject) => {
      if (debounceTimers.has(key)) {
        clearTimeout(debounceTimers.get(key));
      }
      debounceTimers.set(key, setTimeout(() => {
        debounceTimers.delete(key);
        fn().then(resolve).catch(reject);
      }, delay));
    });
  }

  window.FirebaseSync = {

    init(firebaseConfig) {
      return new Promise((resolve, reject) => {
        try {
          if (!firebase.apps.length) {
            firebase.initializeApp(firebaseConfig);
          }

          db = firebase.firestore();

          db.enablePersistence({ synchronizeTabs: true }).catch((err) => {
            if (err.code === 'failed-precondition') {
              console.warn('FirebaseSync: Persistence failed - multiple tabs open');
            } else if (err.code === 'unimplemented') {
              console.warn('FirebaseSync: Persistence not supported in this browser');
            }
          });

          console.log('FirebaseSync: Connected with fixed UID');
          resolve({ uid: FIXED_UID });
        } catch (err) {
          reject(err);
        }
      });
    },

    onAuthChanged(callback) {
      // No auth changes — always "logged in"
      callback({ uid: FIXED_UID, isAnonymous: false, displayName: 'Andreas', email: 'andreas993@gmail.com' });
      return () => {}; // noop unsubscribe
    },

    getUser() {
      return {
        uid: FIXED_UID,
        isAnonymous: false,
        displayName: 'Andreas',
        email: 'andreas993@gmail.com'
      };
    },

    signInWithGoogle() {
      // Already "signed in" — no-op
      return Promise.resolve({ uid: FIXED_UID });
    },

    signOut() {
      // No-op
      return Promise.resolve();
    },

    save(key, data) {
      const delay = key === 'notebook' ? 2000 : 500;
      return debounce(key, () => {
        return docRef(key).set({
          payload: data,
          updatedAt: firebase.firestore.FieldValue.serverTimestamp()
        }, { merge: true });
      }, delay);
    },

    listen(key, callback) {
      return docRef(key).onSnapshot((snapshot) => {
        if (!snapshot.exists) return;
        if (snapshot.metadata.hasPendingWrites) return;
        const docData = snapshot.data();
        if (docData && docData.payload !== undefined) {
          callback(docData.payload);
        }
      });
    },

    migrateFromLocalStorage(localData) {
      const keys = ['notes', 'recurring', 'notebook', 'smartLinks', 'notifSettings'];
      const promises = keys.map((key) => {
        if (localData[key] === undefined || localData[key] === null) {
          return Promise.resolve();
        }
        return docRef(key).get().then((doc) => {
          if (!doc.exists) {
            return docRef(key).set({
              payload: localData[key],
              updatedAt: firebase.firestore.FieldValue.serverTimestamp()
            });
          }
        });
      });
      return Promise.all(promises);
    }
  };
})();
