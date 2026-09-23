# HARDINKAAM Payment Backend (Render)

Sirf Razorpay ke liye chhota Express server. Firebase Hosting/Firestore/Auth ko iski zaroorat nahi — wo waise hi chalte rahenge.

## Render par deploy karne ke steps

1. render.com par jaakar GitHub se sign up karein.
2. Is folder ko ek naye GitHub repo mein push karein (e.g. `hardinkaam-payment-backend`).
3. Render dashboard mein **New +** → **Web Service** par click karein, apna GitHub repo select karein.
4. Settings:
   - **Build Command:** `npm install`
   - **Start Command:** `npm start`
   - **Instance Type:** Free
5. **Environment** tab mein ye variables add karein:
   - `RAZORPAY_KEY_ID` = aapki Razorpay live/test Key ID
   - `RAZORPAY_KEY_SECRET` = aapki Razorpay Key Secret
   - `ALLOWED_ORIGINS` = aapki Firebase Hosting site ka URL (jaise `https://hardinkaam-5cc6a.web.app`)
6. Deploy karein. Render aapko ek URL dega, jaise:
   `https://hardinkaam-payment-backend.onrender.com`
7. Check karein: browser mein `https://<your-render-url>/api/health` khol kar dekhein — `{"status":"ok",...}` dikhna chahiye.

Iske baad frontend (`razorpayService.ts`) mein endpoint URLs ko is Render URL se point karna hoga — ye Phase 2 mein karenge.
