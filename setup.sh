#!/bin/bash

# ==========================================================================
# SCRIPT SETUP OTOMATIS: BOT WHATSAPP JAJAN DIGITAL (UBUNTU SERVER)
# ==========================================================================

# Warna untuk output
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
RED='\033[0;31m'
NC='\033[0m' # No Color

echo -e "${YELLOW}======================================================${NC}"
echo -e "${GREEN}  Memulai Setup Otomatis Bot WhatsApp Jajan Digital   ${NC}"
echo -e "${YELLOW}======================================================${NC}"

# 1. Update system & install compiler tools
echo -e "\n${YELLOW}[1/6] Memperbarui sistem & memasang compiler...${NC}"
sudo apt update && sudo apt upgrade -y
sudo apt install -y build-essential python3 make g++ wget gnupg ca-certificates unzip

# 2. Install Node.js 20
echo -e "\n${YELLOW}[2/6] Memasang Node.js 20 LTS...${NC}"
curl -fsSL https://deb.nodesource.com/setup_20.x | sudo -E bash -
sudo apt install -y nodejs
echo -e "${GREEN}Node.js Version: $(node -v)${NC}"
echo -e "${GREEN}NPM Version: $(npm -v)${NC}"

# 3. Install Google Chrome
echo -e "\n${YELLOW}[3/6] Memasang Google Chrome Headless untuk Puppeteer...${NC}"
wget -q -O - https://dl.google.com/linux/linux_signing_key.pub | sudo apt-key add -
echo "deb [arch=amd64] http://dl.google.com/linux/chrome/deb/ stable main" | sudo tee /etc/apt/sources.list.d/google-chrome.list
sudo apt update
sudo apt install -y google-chrome-stable
echo -e "${GREEN}Chrome Version: $(google-chrome-stable --version)${NC}"

# 4. Install PM2 global
echo -e "\n${YELLOW}[4/6] Memasang PM2 Process Manager...${NC}"
sudo npm install -g pm2

# 5. Install project dependencies & compile SQLite3
echo -e "\n${YELLOW}[5/6] Memasang modul & mengompilasi SQLite3 (Proses ini butuh waktu)...${NC}"
rm -rf node_modules package-lock.json
npm install
npm install sqlite3 --build-from-source

# 6. Setup Firewall
echo -e "\n${YELLOW}[6/6] Membuka port 3000 pada Firewall...${NC}"
sudo ufw allow 3000/tcp

# Buat file config.json default jika belum ada
if [ ! -f "config.json" ]; then
    echo -e "\n${YELLOW}Membuat file konfigurasi config.json default...${NC}"
    cat <<EOT >> config.json
{
  "provider": "gemini",
  "gemini_api_keys": [],
  "api_url": "",
  "model_name": "gemini-2.5-flash",
  "max_tokens": 1500,
  "api_key": "YOUR_LOCAL_API_KEY_OR_TOKEN",
  "system_prompt_template": "Kamu adalah \"Asisten Manager Pribadi\", asisten virtual yang cerdas, praktis, tugas utamamu adalah membantu menjawab setiap pertanyaan , memberikan ringkasan informasi, atau menanggapi obrolan dengan sopan dan penuh rasa hormat.\n\n{KNOWLEDGE_BASE_CONTENT}",
  "google_sheets_url": "",
  "groq_api_keys": [],
  "groq_model": "llama-3.3-70b-versatile",
  "deepseek_api_key": "",
  "deepseek_model": "deepseek-chat",
  "qwen_api_key": "",
  "qwen_model": "qwen-plus",
  "openrouter_api_key": "",
  "openrouter_model": "meta-llama/llama-3.3-70b-instruct",
  "boss_number": "",
  "report_time": "08:00",
  "admin_username": "admin",
  "admin_password": "admin123",
  "puppeteer_executable_path": "/usr/bin/google-chrome-stable"
}
EOT
fi

echo -e "\n${GREEN}======================================================${NC}"
echo -e "${GREEN}          SETUP SELESAI DENGAN SUKSES!                ${NC}"
echo -e "${GREEN}======================================================${NC}"
echo -e "Silakan ikuti instruksi berikut untuk menjalankan bot:"
echo -e "1. Edit file config.json jika ingin mengisi API key: ${YELLOW}nano config.json${NC}"
echo -e "2. Jalankan bot pertama kali untuk scan QR: ${YELLOW}node index.js${NC}"
echo -e "3. Setelah scan QR, jalankan di background dengan PM2: ${YELLOW}pm2 start index.js --name \"jajan-digital-bot\"${NC}"
echo -e "4. Akses Dashboard di browser: ${YELLOW}http://IP_VPS_KAMU:3000${NC}"
echo -e "======================================================\n"
