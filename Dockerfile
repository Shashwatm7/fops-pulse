FROM node:22-slim

# curl for healthchecks/debugging; build-essential for any native npm deps
RUN apt-get update && apt-get install -y curl build-essential && rm -rf /var/lib/apt/lists/*

WORKDIR /usr/src/app

# Install Node dependencies
COPY package*.json ./
RUN npm install

# Copy frontend source and install dependencies
COPY dashboard/package*.json ./dashboard/
RUN cd dashboard && npm install

# Copy all other source code
COPY . .

# Build frontend
RUN npm run build

# Single Node process: migrate then start the server (see package.json "start")
CMD ["npm", "start"]
