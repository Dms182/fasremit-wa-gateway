FROM node:18

# Set environment variables
ENV PORT=7860

# Set working directory
WORKDIR /app

# Copy package files
COPY package*.json ./

# Install npm dependencies (full node image has git pre-installed)
RUN npm install

# Copy application files
COPY . .

# Expose port (Hugging Face expects 7860)
EXPOSE 7860

# Start the application
CMD ["node", "server.js"]
