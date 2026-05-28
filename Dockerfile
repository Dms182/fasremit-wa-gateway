FROM ghcr.io/puppeteer/puppeteer:latest

# Set environment variables for Puppeteer
ENV PUPPETEER_SKIP_CHROMIUM_DOWNLOAD=true
ENV PUPPETEER_EXECUTABLE_PATH=/usr/bin/google-chrome-stable

# Set working directory inside home folder of pptruser (writable by default)
WORKDIR /home/pptruser/app

# Copy package files first
COPY --chown=pptruser:pptruser package*.json ./

# Install npm dependencies
RUN npm install

# Copy application files
COPY --chown=pptruser:pptruser . .

# Expose port (Render will inject PORT env var, Express server uses process.env.PORT)
EXPOSE 3001

# Start the application
CMD ["node", "server.js"]
