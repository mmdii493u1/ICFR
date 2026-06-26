# ICFR (Indicates Cloudflare Requests)

Monitor the remaining request quota of your Cloudflare account directly from Telegram. ICFR is an open-source Telegram bot that allows you to register one or more Cloudflare accounts and quickly check their remaining request quota.

---

# Prerequisites

Before using this project, make sure you have the following:

* A Cloudflare account
* A Telegram bot token using **@BotFather**
* A Telegram use id using **@userinfobot**


---

# Deploying the Cloudflare Worker

## Step 1 – Create a Worker

Log in to your Cloudflare Dashboard.

From the left sidebar, navigate to:

```
Compute → Workers & Pages
```

Click **Create Application** in the upper-right corner.

Select:

```
Start with Hello World
```

After the Worker is created, click **Edit Code**.

> **Note**
>
> If you don't see the **Edit Code** button, first open your Worker from the Workers list.

---

## Step 2 – Replace the Worker Code

Delete the default Worker code (`worker.js`), then either:

* Upload the `worker.js` file included in this project, or
* Copy the contents of the project's `worker.js` file and paste it into the Cloudflare editor.

---

## Step 3 – Configure the Admin Telegram ID

Before deploying the Worker, edit the following variable located near the top of `worker.js`:

```javascript
CONFIG_ADMIN_TELEGRAM_ID
```

Replace its value with the **numeric Telegram ID** of the account that should have administrator access to the bot.

Only this Telegram account will be able to access the Admin Panel.

You can obtain your numeric Telegram ID by messaging:

```
@userinfobot
```

---

## Step 4 – Deploy the Worker

After replacing the code and configuring the administrator ID, click:

```
Deploy
```

Wait until Cloudflare finishes deploying your Worker.

---

# Configure Worker Secrets

After deployment, open your Worker and navigate to:

```
Settings → Variables and Secrets
```

Click **Add** and create the following **Secret** variables.

---

## Secret 1

**Name**

```
TELEGRAM_BOT_TOKEN
```

**Value**

Create a Telegram bot using **@BotFather**.

Run:

```
/newbot
```

Follow the instructions provided by BotFather.

After the bot is created, BotFather will give you an HTTP API Token.

Example:

```text
123456789:AAxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx
```

Paste this token as the value of **TELEGRAM_BOT_TOKEN**.

Click **Deploy** to save the changes.

---

## Secret 2

Create another Secret variable.

**Name**

```
BOT_PASSWORD
```

**Value**

Choose any secure password.

This password will be required when logging into the Telegram bot for the first time.

> ⚠️ Keep this password in a safe place. You will need it to access the bot.

Click **Deploy** again after saving the variable.



# Create a KV Namespace

The bot stores its data using **Cloudflare Workers KV**.

Open the Cloudflare Dashboard and navigate to:

```text
Storage & Databases → Workers KV
```

Click **Create Instance**.

Enter any name for your KV namespace and click **Create**.

---

# Bind the KV Namespace to Your Worker

After creating the KV namespace, return to:

```text
Compute → Workers & Pages
```

Open the Worker you created earlier.

Navigate to:

```text
Settings → Bindings
```

Click **Add Binding**.

Configure the binding as follows:

### Binding Type

```text
KV Namespace
```

### Variable Name

```text
KV
```

> **Important**
>
> The variable name **must be exactly `KV` (uppercase)**.

### KV Namespace

Select the KV namespace you created in the previous step.

Finally, click **Add Binding**.


# Configure the Telegram Webhook

Now you need to tell Telegram to send all incoming bot updates to your Cloudflare Worker.

Open your browser and visit the following URL:

```text
https://api.telegram.org/bot<YOUR_BOT_TOKEN>/setWebhook?url=<YOUR_WORKER_URL>
```

Example:

```text
https://api.telegram.org/bot123456789:ABCdefGhIJKlmNoPQRsTUVwxyZ/setWebhook?url=https://my-bot.my-subdomain.workers.dev
```

Replace:

* `<YOUR_BOT_TOKEN>` with the token you received from **@BotFather**.
* `<YOUR_WORKER_URL>` with your Cloudflare Worker URL.

You can find your Worker URL by opening your Worker and clicking **Visit**.

If everything has been configured correctly, Telegram will return:

```json
{
  "ok": true,
  "result": true,
  "description": "Webhook was set"
}
```

Congratulations! 🎉

Your Telegram bot is now connected to your Cloudflare Worker, and all incoming updates will be delivered automatically.


# Add Your Cloudflare Account

The Cloudflare setup is now complete.

Open your Telegram bot and start it.

When prompted, enter the password you configured in the **BOT_PASSWORD** secret.

After logging in, tap:

```text
Add Cloudflare Account
```

The bot will ask for the following information.

---

## Step 1 – Account Name

Enter a friendly name for the account.

This name will only be used inside the bot to identify the account.

Example:

```text
Personal Account
Production
Main Account
```

---

## Step 2 – Account ID

Open your Cloudflare Dashboard and navigate to:

```text
Compute → Workers & Pages
```

Your **Account ID** is displayed in the lower-right section of the page.

Copy it and send it to the bot.

## Step 3 – Create an API Token

Open your Cloudflare Dashboard.

Click your profile icon in the upper-right corner.

Navigate to:

```text
Profile → API Tokens
```

Click:

```text
Create Token
```

Then select:

```text
Create Custom Token
```

> **Important**
>
> You must enter a name for the custom token before continuing.

Grant the following permission:

| Resource | Permission        |      |
| -------- | ----------------- | ---- |
| Account  | Account Analytics | Read |

Continue by clicking:

```text
Continue to Summary
```

Then click:

```text
Create Token
```

Copy the generated token and send it to the Telegram bot.


# View Remaining Requests

Once the account has been added successfully, tap:

```text
Remaining Requests
```

The bot will display the remaining request quota for the selected Cloudflare account.

If multiple accounts have been added, each account will appear using the name you assigned during setup, making it easy to monitor them individually.

---

## You're All Set!

Your ICFR bot is now fully configured and ready to monitor your Cloudflare account request quota directly from Telegram.

