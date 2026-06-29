# Use official Node.js Alpine image for a dramatically smaller and faster container
FROM node:22-alpine

# Install build tools required for native Node.js addons (e.g. bcrypt, sqlite)
RUN apk add --no-cache python3 make g++

# Set working directory
WORKDIR /usr/src/app

# Copy package.json first for better caching
COPY package*.json ./

# Install Node.js dependencies
RUN npm install

# Copy all source files (respects .dockerignore)
COPY . .

# Build the Vite React Frontend
RUN npm run build

# Expose the dynamically assigned port (Azure assigns process.env.PORT, usually 8080)
EXPOSE 3001

# Start the Express server and migrations
CMD ["npm", "start"]
