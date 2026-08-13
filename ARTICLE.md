# How to Ask Claude About Your Oura Ring Data, Including From Your Phone

Oura gives you a lot of numbers every morning. A sleep score, a readiness score, HRV, resting heart rate, activity. The app shows you each one on its own, but it is not great at answering questions that cut across them. Things like "has my resting heart rate crept up since I started training again?" or "which nights this month did I actually get enough deep sleep?"

Claude is good at those questions. It just needs access to your data.

This guide walks through setting that up. When you are done, you can ask Claude about your Oura data on the web, on the desktop app, and on your phone. The whole thing runs on a small server you control, and it takes about fifteen minutes.

## What you are building

There is a standard called the Model Context Protocol, or MCP, that lets Claude talk to outside services. An MCP server sits between Claude and some data source and exposes a set of tools that Claude can call.

Most MCP servers you find run on your own machine. That works fine for desktop use, but it means your phone cannot reach them. Your phone is not going to connect to a program running on your laptop.

So this one is hosted. You deploy it to Railway, it gets a public web address, and you connect Claude to that address. Because the connection is tied to your Claude account rather than to one device, it shows up everywhere you use Claude.

Your Oura token stays on the server. It is never sent to Claude. The server is protected by a password you choose plus a standard OAuth sign in, so a stranger who finds the URL cannot read your health data.

## What you need

* An Oura account and a ring with some data in it
* A GitHub account, free
* A Railway account, which has a free starting tier and costs a few dollars a month after that
* A paid Claude plan, since custom connectors are not available on the free tier
* About fifteen minutes

## Step 1: Get your Oura token

Go to [cloud.ouraring.com/personal-access-tokens](https://cloud.ouraring.com/personal-access-tokens) and sign in with your Oura account.

Create a new personal access token. Give it any name you like. Copy the token somewhere safe as soon as it appears, because Oura will not show it to you again.

This token is what the server uses to read your data. Treat it like a password.

## Step 2: Fork the repository

Go to [github.com/jaredstauffer/oura-mcp-server](https://github.com/jaredstauffer/oura-mcp-server) and click Fork in the top right.

Forking gives you your own copy under your own GitHub account. You want this rather than deploying from my copy directly, for two reasons. Railway connects to repositories you own, and having your own copy means you can change things later without asking anyone.

## Step 3: Deploy it to Railway

Sign in at [railway.com](https://railway.com) with your GitHub account.

Click New Project, then Deploy from GitHub repo, and pick your fork of oura-mcp-server. If you do not see it in the list, Railway needs permission to view it. Go to [github.com/settings/installations](https://github.com/settings/installations), click Configure next to Railway, and either add the repository to the allowed list or switch to All repositories.

Railway will start building straight away. The first build will succeed but the server will not start yet, because it does not have its settings. That is expected, and the next step fixes it.

## Step 4: Add three settings

Open your service in Railway and go to the Variables tab. Add these three.

**OURA_PERSONAL_ACCESS_TOKEN**
The token you copied in step 1.

**MCP_AUTH_PASSWORD**
A password you invent right now. You will type this once, when you connect Claude. Make it a real password, not `oura123`. This is the only thing standing between the public internet and your health data.

**OAUTH_SIGNING_SECRET**
A long random string. Generate one by running this in a terminal:

```
openssl rand -hex 32
```

If you are on Windows without openssl, any random 64 character string of letters and numbers will do. Paste the result in.

There is one optional fourth setting worth adding.

**OURA_TIMEZONE**
Your timezone in IANA format, for example `America/Phoenix` or `Europe/London`. This decides where your days start and end. Without it the server assumes UTC, which will put your "last 7 days" off by a day for part of every day if you are not in the UK. You can find your zone in [this list](https://en.wikipedia.org/wiki/List_of_tz_database_time_zones).

## Step 5: Give it a public address

Still in Railway, go to Settings, find the Networking section, and click Generate Domain under Public Networking.

Railway will give you an address like `oura-mcp-server-production.up.railway.app`. Copy it.

Now redeploy. This part matters and it is easy to miss. The server reads its own address from a variable Railway only creates once the domain exists, so a deployment that ran before you generated the domain will not know its own name. Trigger a fresh deploy from the Railway dashboard.

## Step 6: Check that it is running

Open this in your browser, using your own domain:

```
https://your-app.up.railway.app/healthz
```

You should see:

```json
{"status": "ok"}
```

If you see that, the server is up and you are nearly finished.

If instead the deployment keeps restarting, open the deploy logs. The server checks its settings when it starts and refuses to run with a piece missing, and it names the missing piece in plain language. Add whatever it asks for and it will come up.

## Step 7: Connect Claude

Go to [claude.ai](https://claude.ai), open Settings, and find Connectors. Click Add custom connector.

For the URL, enter your domain with `/mcp` at the end:

```
https://your-app.up.railway.app/mcp
```

That last part is important. The bare domain will not work.

Leave the OAuth client ID and secret fields empty. The server handles registration by itself, so there is nothing for you to fill in there.

Click through, and a sign in page will appear asking for a password. This is the `MCP_AUTH_PASSWORD` you chose in step 4. Enter it, and you are connected.

## Step 8: Ask it something

Start a new conversation and try one of these:

* How did I sleep last night?
* What has my readiness been over the past two weeks?
* Compare my deep sleep in July against August.
* Have my workouts affected my resting heart rate?

Then open Claude on your phone and ask the same thing. It works there too, with no extra setup, because the connector belongs to your account rather than to a device.

## What it can actually read

The server exposes thirteen tools covering the Oura v2 API:

* **Sleep.** Nightly sleep score, plus detailed per night stage durations, heart rate, HRV, and breathing rate.
* **Readiness.** Daily readiness score, its contributors, and body temperature deviation.
* **Activity.** Activity score, calories, MET minutes, and time at each activity level.
* **Workouts.** Activity type, intensity, calories, distance, start and end times.
* **Sessions.** Breathing exercises, meditation, and naps.
* **Stress.** Daily time spent in high stress and in recovery.
* **Resilience.** A longer term measure of how well you are handling stress.
* **Health markers.** SpO2, cardiovascular age, and VO2 max.
* **Rest mode.** Periods when you had rest mode switched on.

Each tool describes itself to Claude, so you do not have to name them. Ask about sleep stages and Claude reaches for the detailed sleep data. Ask how well you slept and it reaches for the score instead.

## A note on privacy

Worth being clear about where things sit.

Your Oura token lives in Railway's environment variables and is used only by your server to call Oura. It never reaches Claude.

Your health data does pass through Claude when you ask about it, in the same way anything you type into a conversation does. If that matters to you, read Anthropic's privacy policy before you start.

The server itself is locked. Every request has to carry a valid token, and getting one means signing in with your password through a standard OAuth flow with PKCE. Sign in attempts are rate limited, so the password cannot be guessed by brute force. If you ever want to cut off access, change `OAUTH_SIGNING_SECRET` in Railway and every existing session stops working immediately.

## If something goes wrong

**Railway cannot find your repository.** It needs permission. Go to [github.com/settings/installations](https://github.com/settings/installations), click Configure next to Railway, and grant access to the repository.

**The build fails.** Check that you forked the repository rather than copying files across by hand. The repository includes a `railway.json` that tells Railway how to build it, and without that file Railway guesses.

**The service keeps restarting.** A setting is missing. The deploy log will name it. This is deliberate: the server would rather refuse to start than run in a state where it half works.

**Claude will not connect.** Check that your connector URL ends in `/mcp`. Then check that the last line of your deploy log shows the same address you are actually using. If they do not match, redeploy after generating the domain.

**Claude connects but says it cannot get your data.** Your Oura token is probably wrong or expired. Generate a fresh one and update the variable in Railway.

**The dates look off by a day.** Set `OURA_TIMEZONE` to your own zone and redeploy.

## Running it locally instead

If you only want this on your laptop and do not care about phone access, you can skip Railway entirely. Clone your fork, then:

```
npm install
npm run build
```

For Claude Code:

```
claude mcp add oura -s user \
  -e OURA_PERSONAL_ACCESS_TOKEN=your_token \
  -- "$(command -v node)" /full/path/to/oura-mcp-server/build/index.js
```

For Claude Desktop, open Settings, then Developer, then Edit Config, and add:

```json
{
  "mcpServers": {
    "oura": {
      "command": "/full/path/to/node",
      "args": ["/full/path/to/oura-mcp-server/build/index.js"],
      "env": { "OURA_PERSONAL_ACCESS_TOKEN": "your_token" }
    }
  }
}
```

Use full paths in both cases. Claude Desktop does not inherit your shell's PATH, so a bare `node` will often not be found.

## Where to go from here

The repository is yours now. A few things people tend to want next: more Oura endpoints, since heart rate and tags are in the API but not yet exposed here; a scheduled weekly summary; or connecting a second data source alongside it, so Claude can look at sleep next to your calendar or your training log.

---

*This is built on top of [oura-mcp](https://github.com/elizabethtrykin/oura-mcp) by [elizabethtrykin](https://github.com/elizabethtrykin), which is where the original server and its Oura API work came from. This version adds hosted deployment with OAuth so it can be reached from the web and mobile apps, along with pagination, tests, and a few fixes. Thanks to Elizabeth for the foundation.*
