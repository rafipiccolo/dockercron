export default function delay(timeout) {
    return new Promise((resolve, reject) => {
        setTimeout(resolve, timeout);
    });
}
