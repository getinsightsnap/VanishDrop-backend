# VanishDrop Backend API

Backend API for VanishDrop file sharing application built with Express.js and Supabase.

## 📁 Project Structure

```
backend/
├── config/
│   └── supabase.js          # Supabase client configuration
├── functions/
│   ├── index.js             # Main Express server
│   ├── middleware/
│   │   └── auth.js          # Authentication middleware
│   └── routes/
│       ├── files.js         # File management endpoints
│       ├── users.js         # User profile endpoints
│       └── share.js         # Share link endpoints
├── supabase/
│   └── supabase-schema.sql  # Database schema
├── package.json
├── env.example              # Environment variables template
└── README.md
```

## 🚀 Setup Instructions

### 1. Install Dependencies

```bash
cd backend
npm install
```

### 2. Configure Environment Variables

Create a `.env` file in the backend directory:

```bash
cp env.example .env
```

Update the `.env` file with your Supabase credentials:

```env
SUPABASE_URL=https://mafttcvhinlestxrtjfa.supabase.co
SUPABASE_ANON_KEY=your_anon_key
SUPABASE_SERVICE_ROLE_KEY=your_service_role_key
PORT=3000
NODE_ENV=development
FRONTEND_URL=http://localhost:5175
```

### 3. Set Up Database

1. Go to your Supabase Dashboard
2. Navigate to SQL Editor
3. Run the SQL script from `supabase/supabase-schema.sql`

### 4. Start Development Server

```bash
npm run dev
```

The API will be available at `http://localhost:3000`

## 📡 API Endpoints

### Health Check
- `GET /health` - Check API status

### Files
- `GET /api/files` - Get user's files (auth required)
- `POST /api/files/upload` - Upload file metadata (auth required)
- `GET /api/files/:fileId` - Get file by ID (auth required)
- `DELETE /api/files/:fileId` - Delete file (auth required)

### Users
- `GET /api/users/profile` - Get user profile (auth required)
- `PATCH /api/users/subscription` - Update subscription tier (auth required)
- `POST /api/users/trial` - Start 7-day trial (auth required)
- `GET /api/users/stats` - Get user statistics (auth required)
- `POST /api/users/reset-daily-limit` - Check and reset daily limit (auth required)

### Share Links
- `POST /api/share` - Create share link (auth required)
- `GET /api/share/:token` - Get share link by token (public)
- `POST /api/share/:token/access` - Access file via share link (public)
- `GET /api/share/user/links` - Get user's share links (auth required)
- `DELETE /api/share/:linkId` - Delete share link (auth required)
- `GET /api/share/:linkId/logs` - Get access logs (auth required)

## 🔐 Authentication

All protected endpoints require a Bearer token in the Authorization header:

```
Authorization: Bearer <supabase_jwt_token>
```

Get the token from Supabase auth on the frontend and pass it with each request.

## 🌐 Deployment Options

### Option 1: Netlify Functions

1. Install Netlify CLI:
```bash
npm install -g netlify-cli
```

2. Create `netlify.toml` in backend directory:
```toml
[build]
  functions = "functions"

[functions]
  node_bundler = "esbuild"
```

3. Deploy:
```bash
netlify deploy --prod
```

### Option 2: Vercel

1. Install Vercel CLI:
```bash
npm install -g vercel
```

2. Create `vercel.json`:
```json
{
  "version": 2,
  "builds": [
    {
      "src": "functions/index.js",
      "use": "@vercel/node"
    }
  ],
  "routes": [
    {
      "src": "/(.*)",
      "dest": "functions/index.js"
    }
  ]
}
```

3. Deploy:
```bash
vercel --prod
```

### Option 3: Railway

1. Install Railway CLI:
```bash
npm install -g @railway/cli
```

2. Deploy:
```bash
railway login
railway init
railway up
```

### Option 4: Render

1. Create a new Web Service on Render.com
2. Connect your GitHub repository
3. Set build command: `cd backend && npm install`
4. Set start command: `cd backend && npm start`
5. Add environment variables in Render dashboard

### Option 5: Supabase Edge Functions

1. Install Supabase CLI:
```bash
npm install -g supabase
```

2. Initialize Supabase:
```bash
supabase init
```

3. Deploy functions:
```bash
supabase functions deploy
```

## 🔧 Environment Variables for Production

Make sure to set these in your deployment platform:

- `SUPABASE_URL`
- `SUPABASE_ANON_KEY`
- `SUPABASE_SERVICE_ROLE_KEY`
- `PORT` (optional, usually auto-assigned)
- `NODE_ENV=production`
- `FRONTEND_URL` (your deployed frontend URL)

## 📊 Monitoring

### Logs
Check application logs in your deployment platform's dashboard.

### Database
Monitor database performance in Supabase Dashboard > Database > Performance.

### Storage
Track storage usage in Supabase Dashboard > Storage.

## 🛠️ Development

### Run with auto-reload:
```bash
npm run dev
```

### Run in production mode:
```bash
npm start
```

## 🔒 Security Best Practices

1. **Never commit `.env` file** - It's in `.gitignore`
2. **Use service role key only in backend** - Never expose it to frontend
3. **Validate all inputs** - Sanitize user data
4. **Rate limiting** - Implement rate limiting for public endpoints
5. **CORS** - Configure CORS properly for your frontend domain
6. **HTTPS only** - Always use HTTPS in production

## 📝 API Response Format

### Success Response
```json
{
  "data": { ... },
  "message": "Success message"
}
```

### Error Response
```json
{
  "error": "Error message",
  "details": "Additional details (dev only)"
}
```

## 🐛 Troubleshooting

### Port already in use
```bash
# Kill process on port 3000
npx kill-port 3000
```

### Database connection issues
- Check Supabase credentials
- Verify database is accessible
- Check RLS policies

### CORS errors
- Verify `FRONTEND_URL` in `.env`
- Check CORS configuration in `functions/index.js`

## 📞 Support

For issues:
- Email: dropvanish@gmail.com
- Check Supabase logs
- Review application logs

## 📄 License

MIT
