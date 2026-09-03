// Firebase project config — from Firebase Console → Project settings → General → Your apps → SDK setup and configuration
// Replace every REPLACE_ME value before deploying.
firebase.initializeApp({
  apiKey: "AIzaSyBMdyvRf4ap3cdsUc5Y2O3W8P9E5uUP84E",
  authDomain: "second-brain-b97ba.firebaseapp.com",
  projectId: "second-brain-b97ba",
  storageBucket: "second-brain-b97ba.firebasestorage.app",
  messagingSenderId: "170549537239",
  appId: "1:170549537239:web:00c1631a8143ed1c26c392"
});
window.db = firebase.firestore();
