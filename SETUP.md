# ImpulseMotion — Setup Guide

## Quick Start (Mock Data)

No accounts needed to explore the app:

```bash
npm install
npm run dev
```

Open [http://localhost:3000](http://localhost:3000) — the app loads with demo data.

---

## Connect Real Ad Accounts

### 1. Configure environment variables

Copy the example file:

```bash
cp .env.local.example .env.local
```

Then fill in the values (see below).

---

### 2. Meta Ads (Facebook)

**Create a Meta App:**

1. Go to [developers.facebook.com/apps](https://developers.facebook.com/apps)
2. Click **Create App** → select **Business** type
3. Add the **Marketing API** product
4. In **App Settings → Basic**, copy your **App ID** and **App Secret**
5. Add OAuth redirect URI: `http://localhost:3000/api/auth/callback/facebook`
6. In **App Review → Permissions**, add: `ads_read`, `ads_management`, `read_insights`

Fill in `.env.local`:

```
FACEBOOK_APP_ID=<your app id>
FACEBOOK_APP_SECRET=<your app secret>
```

---

### 3. TikTok Ads

**Create a TikTok Marketing App:**

1. Go to [ads.tiktok.com/marketing_api/apps](https://ads.tiktok.com/marketing_api/apps)
2. Click **Create App**
3. Copy your **App ID** and **App Secret**
4. Add OAuth redirect URI: `http://localhost:3000/api/auth/callback/tiktok`
5. Request scopes: `advertiser.read`, `reporting.read`

Fill in `.env.local`:

```
TIKTOK_APP_ID=<your app id>
TIKTOK_APP_SECRET=<your app secret>
```

---

### 4. Generate Auth Secret

```bash
openssl rand -base64 32
```

Paste the result as `AUTH_SECRET` in `.env.local`.

---

### 5. Run the app

```bash
npm run dev
```

Go to **Settings** → click **Connect Meta** or **Connect TikTok** → OAuth flow starts → select your ad account → real data loads.

---

## Production Deployment

Update `NEXTAUTH_URL` to your production URL and configure the OAuth redirect URIs accordingly in your Meta and TikTok app settings.
