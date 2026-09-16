        // --- 1. FIREBASE INITIALIZATION ---
        const firebaseConfig = {
            apiKey: "AIzaSyCeM8RGdRFEu8eEWvEOqEgjUAm3_mXOCWk",
            authDomain: "suzans-security-app.firebaseapp.com",
            projectId: "suzans-security-app",
            storageBucket: "suzans-security-app.firebasestorage.app",
            messagingSenderId: "754272810044",
            appId: "1:754272810044:web:cbcabb5e7431aa052c7f39"
        };
        firebase.initializeApp(firebaseConfig);
        const db = firebase.firestore();
        const auth = firebase.auth();

