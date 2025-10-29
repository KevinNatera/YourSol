// Import the functions you need from the SDKs you need
import { initializeApp } from "firebase/app";
import { getFirestore } from "firebase/firestore";
import { getAuth } from "firebase/auth";

// Your web app's Firebase configuration using Vite's env variables
const firebaseConfig = {
  apiKey: "AIzaSyA1WIVfbxpxQ4dTJIrfOYCcEfoT2_AiY90",
  authDomain: "yoursol-da249.firebaseapp.com",
  projectId: "yoursol-da249",
  storageBucket: "yoursol-da249.firebasestorage.app",
  messagingSenderId: "872977665939",
  appId: "1:872977665939:web:ae2065332fa8c88a43e266",
};

// Initialize Firebase
const app = initializeApp(firebaseConfig);

// Initialize Cloud Firestore and get a reference to the service
export const db = getFirestore(app);
export const auth = getAuth(app);
