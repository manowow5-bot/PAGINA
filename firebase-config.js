// Firebase config dedicated to CHATDEVOZ.
const firebaseConfig = {
  apiKey: "AIzaSyDoMnlTZVdd9ulkZlGjGUwXzKtmlnUCfXc",
  authDomain: "x7sebaspanel.firebaseapp.com",
  projectId: "x7sebaspanel",
  storageBucket: "x7sebaspanel.firebasestorage.app",
  messagingSenderId: "11380640205",
  appId: "1:11380640205:web:abf1fa3bba3a6b631b5c84"
};

if (!firebase.apps.length) {
  firebase.initializeApp(firebaseConfig);
}

window.voiceAuth = firebase.auth();
window.voiceDb = firebase.firestore();
