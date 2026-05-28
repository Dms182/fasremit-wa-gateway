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

# Download the exact Chrome version expected by puppeteer-core at build time (clearing broken cache first)
RUN rm -rf /home/pptruser/app/.puppeteer-cache && npx puppeteer browsers install chrome@146.0.7680.31

# Copy application files
COPY --chown=pptruser:pptruser . .

# Expose port (Hugging Face Spaces expects 7860, Render uses PORT)
EXPOSE 7860

# Start the application
CMD ["node", "server.js"]
