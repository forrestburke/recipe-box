// App configuration. Edit this file when you deploy.
export const config = {
  // Endpoint that fetches a recipe web page on the server (browsers can't fetch other sites directly).
  // Local dev: served by server.js. Firebase: rewritten to the fetchRecipe Cloud Function (see firebase.json).
  fetchProxy: '/api/fetch',

  // Firebase web app config: enables Google sign-in and cloud sync across devices.
  // These values are public identifiers, not secrets; access is enforced by firestore.rules.
  // Set to null to keep everything in this browser only (localStorage).
  firebase: {
    apiKey: 'AIzaSyA3xzn0O1cAzPw6VxGROzvWbZmZqzL_v90',
    authDomain: 'recipe-box-66ae1.firebaseapp.com',
    projectId: 'recipe-box-66ae1',
    storageBucket: 'recipe-box-66ae1.firebasestorage.app',
    messagingSenderId: '811729264103',
    appId: '1:811729264103:web:272197a189699952b0b142',
  },
};
