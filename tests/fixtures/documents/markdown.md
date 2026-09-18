# Markdown attachment preview

This fixture verifies **formatted text**, *emphasis*, and Polish characters: Zażółć gęślą jaźń.

## Release checklist

- [x] Upload from the agent workspace
- [x] Upload from the web widget
- [ ] Publish the widget configuration

## Sample table

| Code | Description | Amount |
| --- | --- | ---: |
| 00123 | First order | 42.50 |
| 00456 | Second order | 19.00 |

## Code sample

```javascript
const message = "Hello, Markdown";
console.log(message);
```

> Documents retain their original download.

[Documentation](https://example.com/documentation)

![External image](https://example.com/tracking-pixel.png)

[Relative resource](./private-file)

[Unsafe link](javascript:alert(1))

<script>window.previewXss = true</script>
<img src="https://example.com/raw-tracking.png" onerror="window.previewXss = true">
