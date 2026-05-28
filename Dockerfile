FROM ghcr.io/puppeteer/puppeteer:latest

# Set environment variables
ENV PORT=7860
ENV PUPPETEER_CACHE_DIR=/home/pptruser/app/.puppeteer-cache

# Set working directory inside home folder of pptruser (writable by default)
WORKDIR /home/pptruser/app

# Copy package files first
COPY --chown=pptruser:pptruser package*.json ./

# Install npm dependencies
RUN npm install

# Copy application files
COPY --chown=pptruser:pptruser . .

# Install Chrome browser matching the puppeteer version inside the app workdir cache (clearing cached folder first if restored)
RUN rm -rf /home/pptruser/app/.puppeteer-cache && npx puppeteer browsers install chrome

# Expose port (Hugging Face Spaces expects 7860, Render uses PORT)
EXPOSE 7860

# Start the application
CMD ["node", "server.js"]
