// App configuration. Edit this file when you deploy.
export const config = {
  // Endpoint that fetches a recipe web page on the server (browsers can't fetch other sites directly).
  // Local dev: served by server.js. Firebase: rewritten to the fetchRecipe Cloud Function (see firebase.json).
  fetchProxy: '/api/fetch',

  // Paste your Firebase web app config here to enable Google sign-in and cloud sync across devices.
  // Firebase console -> Project settings -> Your apps -> Web app -> SDK setup and configuration.
  // Leave as null to keep everything in this browser only (localStorage).
  firebase: null,
  // firebase: {
  //   apiKey: '...',
  //   authDomain: 'your-project.firebaseapp.com',
  //   projectId: 'your-project',
  //   appId: '...',
  // },
};
