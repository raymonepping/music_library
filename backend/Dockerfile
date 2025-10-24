# Base image
FROM node:20.19.4

# Set working directory
WORKDIR /app

# Copy package.json and package-lock.json
COPY package*.json ./

# Install dependencies
RUN npm install

# Copy the rest of the application code
COPY . .

# Expose the port the backend listens on
EXPOSE 3002

# Run the application
CMD ["npm", "start"]