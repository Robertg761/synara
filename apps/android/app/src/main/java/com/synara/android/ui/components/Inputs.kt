package com.synara.android.ui.components

import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.text.KeyboardOptions
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.OutlinedTextFieldDefaults
import androidx.compose.material3.Text
import androidx.compose.material3.TextFieldColors
import androidx.compose.runtime.Composable
import androidx.compose.ui.Modifier
import androidx.compose.ui.text.input.VisualTransformation
import com.synara.android.ui.theme.SynaraTheme

/**
 * One text-field appearance for the whole app: `--input` as the resting fill, `outline` only once
 * focused. Material's default outlined field paints a permanent 1dp box, which reads as heavy
 * against near-monochrome surfaces where every other edge is a 4–5% hairline.
 */
@Composable
fun synaraTextFieldColors(): TextFieldColors = OutlinedTextFieldDefaults.colors(
    focusedContainerColor = SynaraTheme.accents.inputSurface,
    unfocusedContainerColor = SynaraTheme.accents.inputSurface,
    disabledContainerColor = SynaraTheme.accents.mutedSurface,
    focusedBorderColor = MaterialTheme.colorScheme.outline,
    unfocusedBorderColor = MaterialTheme.colorScheme.outlineVariant,
    disabledBorderColor = androidx.compose.ui.graphics.Color.Transparent,
    focusedTextColor = MaterialTheme.colorScheme.onSurface,
    unfocusedTextColor = MaterialTheme.colorScheme.onSurface,
    cursorColor = MaterialTheme.colorScheme.onSurface,
    focusedLabelColor = MaterialTheme.colorScheme.onSurfaceVariant,
    unfocusedLabelColor = MaterialTheme.colorScheme.onSurfaceVariant,
    focusedPlaceholderColor = MaterialTheme.colorScheme.onSurfaceVariant,
    unfocusedPlaceholderColor = MaterialTheme.colorScheme.onSurfaceVariant,
)

/**
 * Labelled field with the label sitting *above* the input rather than floating inside it. On a
 * form of three or four short fields, floating labels make every row change height on focus;
 * a static label keeps the form still while it is being filled in.
 */
@Composable
fun SynaraField(
    label: String,
    value: String,
    onValueChange: (String) -> Unit,
    modifier: Modifier = Modifier,
    placeholder: String? = null,
    supportingText: String? = null,
    enabled: Boolean = true,
    singleLine: Boolean = true,
    maxLines: Int = if (singleLine) 1 else 4,
    isError: Boolean = false,
    monospace: Boolean = false,
    keyboardOptions: KeyboardOptions = KeyboardOptions.Default,
    visualTransformation: VisualTransformation = VisualTransformation.None,
    trailingIcon: (@Composable () -> Unit)? = null,
) {
    Column(
        modifier = modifier.fillMaxWidth(),
        verticalArrangement = Arrangement.spacedBy(SynaraTheme.spacing.xs),
    ) {
        Text(
            label,
            style = MaterialTheme.typography.labelLarge,
            color = MaterialTheme.colorScheme.onSurfaceVariant,
        )
        OutlinedTextField(
            value = value,
            onValueChange = onValueChange,
            modifier = Modifier.fillMaxWidth(),
            placeholder = placeholder?.let {
                {
                    Text(
                        it,
                        style = if (monospace) SynaraTheme.textStyles.mono else MaterialTheme.typography.bodyMedium,
                    )
                }
            },
            textStyle = if (monospace) SynaraTheme.textStyles.mono else MaterialTheme.typography.bodyMedium,
            singleLine = singleLine,
            maxLines = maxLines,
            enabled = enabled,
            isError = isError,
            shape = MaterialTheme.shapes.medium,
            colors = synaraTextFieldColors(),
            keyboardOptions = keyboardOptions,
            visualTransformation = visualTransformation,
            trailingIcon = trailingIcon,
        )
        if (supportingText != null) {
            Text(
                supportingText,
                style = MaterialTheme.typography.bodySmall,
                color = MaterialTheme.colorScheme.onSurfaceVariant,
            )
        }
    }
}
