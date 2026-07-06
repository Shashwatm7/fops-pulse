FROM python:3.10-slim

# Install system dependencies including curl
RUN apt-get update && apt-get install -y curl build-essential && rm -rf /var/lib/apt/lists/*

# Install Node.js 22
RUN curl -fsSL https://deb.nodesource.com/setup_22.x | bash - \
    && apt-get install -y nodejs \
    && apt-get clean \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /usr/src/app

# Copy AI requirements and install Python dependencies
COPY ai_service/requirements.txt ./ai_service/
RUN pip install --no-cache-dir -r ai_service/requirements.txt

# Copy package.json and install Node dependencies
COPY package*.json ./
RUN npm install

# Copy frontend source and install dependencies
COPY dashboard/package*.json ./dashboard/
RUN cd dashboard && npm install

# Copy all other source code
COPY . .

# Build frontend
RUN npm run build

# Ensure startup script is executable
RUN chmod +x start.sh

# Start both services
CMD ["./start.sh"]
